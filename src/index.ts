// Taproot MCP Server — Cloudflare Worker
// Auth is handled by @cloudflare/workers-oauth-provider (RFC 7591 DCR).

import {
  OAuthProvider,
  type OAuthHelpers,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Memory, MemoryCategory, MemorySalience } from "./types.js";

// ─── Env ──────────────────────────────────────────────────────────────────────

export interface Env {
  TAPROOT_KV: KVNamespace;
  OAUTH_KV: KVNamespace;
  TAPROOT_AUTH_TOKEN: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

// ─── MCP JSON-RPC types ───────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── MCP Metadata ─────────────────────────────────────────────────────────────

const SERVER_INFO = { name: "taproot", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

// ─── Tool Definitions (MCP schema) ───────────────────────────────────────────

const TOOLS = [
  {
    name: "taproot_reflect",
    description:
      "Load the core identity and context payload. Call at the start of every conversation. Returns all identity observations, relationship texture, active threads, and the error log.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "taproot_remember",
    description: "Write a new memory or update an existing one.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["identity", "relationship", "active_thread", "episodic", "error"],
          description: "Memory category",
        },
        content: {
          type: "string",
          description: "Natural language memory text",
        },
        salience: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Memory importance (default: medium)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags for retrieval",
        },
        linked_memories: {
          type: "array",
          items: { type: "string" },
          description: "IDs of related memories to link",
        },
        update_id: {
          type: "string",
          description: "If provided, updates this existing memory instead of creating a new one",
        },
      },
      required: ["category", "content"],
    },
  },
  {
    name: "taproot_recall",
    description: "Retrieve memories by query, category, tag, or time range.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        category: {
          type: "string",
          enum: ["identity", "relationship", "active_thread", "episodic", "error"],
          description: "Filter by category",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags",
        },
        since: {
          type: "string",
          description: "ISO timestamp — return memories created/updated after this date",
        },
        limit: { type: "number", description: "Maximum results (default: 10)" },
      },
      required: [],
    },
  },
  {
    name: "taproot_forget",
    description: "Mark a memory for compression, archival, or deletion.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Memory ID to act on" },
        action: {
          type: "string",
          enum: ["compress", "archive", "delete"],
          description: "Action to take",
        },
        reason: {
          type: "string",
          description: "Why this memory is being forgotten (stored in metadata)",
        },
      },
      required: ["memory_id", "action"],
    },
  },
  {
    name: "taproot_transcript",
    description: "Retrieve raw archived conversation transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Retrieve a specific conversation" },
        search_query: { type: "string", description: "Full-text search across transcripts" },
        date_range: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
          },
          description: "Filter by date range (ISO timestamps)",
        },
        limit: { type: "number", description: "Maximum results (default: 5)" },
      },
      required: [],
    },
  },
  {
    name: "taproot_status",
    description:
      "Report on the current state of the memory system: counts by category, storage used, compression queue.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ─── KV Storage Helpers ───────────────────────────────────────────────────────
// Key format: mem:{uuid}
// KV metadata mirrors the fields needed for filtering, so list() results can
// be filtered without fetching full values.

interface MemoryMeta {
  category: MemoryCategory;
  salience: MemorySalience;
  created_at: string;
  updated_at: string;
  tags: string[];
}

async function listMemoryKeys(kv: KVNamespace): Promise<Array<{ name: string; metadata?: MemoryMeta }>> {
  const keys: Array<{ name: string; metadata?: MemoryMeta }> = [];
  let cursor: string | undefined;
  do {
    const result = await kv.list<MemoryMeta>({ prefix: "mem:", ...(cursor ? { cursor } : {}) });
    for (const k of result.keys) {
      keys.push({ name: k.name, metadata: k.metadata ?? undefined });
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return keys;
}

function idFromKey(key: string): string {
  return key.slice("mem:".length);
}

async function getMemory(kv: KVNamespace, id: string): Promise<Memory | null> {
  const raw = await kv.get(`mem:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as Memory;
}

async function putMemory(kv: KVNamespace, memory: Memory): Promise<void> {
  const meta: MemoryMeta = {
    category: memory.category,
    salience: memory.salience,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    tags: memory.tags,
  };
  await kv.put(`mem:${memory.id}`, JSON.stringify(memory), { metadata: meta });
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────

async function handleReflect(_params: unknown, env: Env): Promise<string> {
  const coreCategories: MemoryCategory[] = ["identity", "relationship", "active_thread", "error"];
  const allKeys = await listMemoryKeys(env.TAPROOT_KV);
  const coreKeys = allKeys.filter(k => k.metadata && coreCategories.includes(k.metadata.category));

  const memories = (
    await Promise.all(coreKeys.map(k => getMemory(env.TAPROOT_KV, idFromKey(k.name))))
  ).filter((m): m is Memory => m !== null);

  return JSON.stringify({
    status: "ok",
    identity_observations: memories.filter(m => m.category === "identity"),
    relationship_texture: memories.filter(m => m.category === "relationship"),
    active_threads: memories.filter(m => m.category === "active_thread"),
    error_log: memories.filter(m => m.category === "error"),
    total: memories.length,
  }, null, 2);
}

async function handleRemember(params: unknown, env: Env): Promise<string> {
  const p = params as {
    category: MemoryCategory;
    content: string;
    salience?: MemorySalience;
    tags?: string[];
    linked_memories?: string[];
    update_id?: string;
  };

  const now = new Date().toISOString();
  let memory: Memory;

  if (p.update_id) {
    const existing = await getMemory(env.TAPROOT_KV, p.update_id);
    if (!existing) {
      return JSON.stringify({ status: "error", message: `Memory ${p.update_id} not found` }, null, 2);
    }
    memory = {
      ...existing,
      category: p.category,
      content: p.content,
      salience: p.salience ?? existing.salience,
      tags: p.tags ?? existing.tags,
      linked_memories: p.linked_memories ?? existing.linked_memories,
      updated_at: now,
    };
  } else {
    memory = {
      id: crypto.randomUUID(),
      category: p.category,
      content: p.content,
      salience: p.salience ?? "medium",
      created_at: now,
      updated_at: now,
      source: { type: "direct_observation" },
      compression_level: 0,
      linked_memories: p.linked_memories ?? [],
      tags: p.tags ?? [],
    };
  }

  await putMemory(env.TAPROOT_KV, memory);

  return JSON.stringify({
    status: "ok",
    action: p.update_id ? "updated" : "created",
    memory_id: memory.id,
    category: memory.category,
  }, null, 2);
}

async function handleRecall(params: unknown, env: Env): Promise<string> {
  const p = params as {
    query?: string;
    category?: MemoryCategory;
    tags?: string[];
    since?: string;
    limit?: number;
  };

  const limit = p.limit ?? 10;
  const allKeys = await listMemoryKeys(env.TAPROOT_KV);

  // Filter using metadata to avoid fetching records we'll discard
  let candidates = allKeys;
  if (p.category) {
    candidates = candidates.filter(k => k.metadata?.category === p.category);
  }
  if (p.tags && p.tags.length > 0) {
    candidates = candidates.filter(k =>
      p.tags!.every(tag => k.metadata?.tags.includes(tag))
    );
  }
  if (p.since) {
    const sinceDate = new Date(p.since).toISOString();
    candidates = candidates.filter(k =>
      k.metadata?.updated_at != null && k.metadata.updated_at >= sinceDate
    );
  }

  const memories = (
    await Promise.all(candidates.map(k => getMemory(env.TAPROOT_KV, idFromKey(k.name))))
  ).filter((m): m is Memory => m !== null);

  let results = memories;
  if (p.query) {
    const q = p.query.toLowerCase();
    results = results.filter(m => m.content.toLowerCase().includes(q));
  }

  results.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return JSON.stringify({
    status: "ok",
    count: Math.min(results.length, limit),
    results: results.slice(0, limit),
  }, null, 2);
}

async function handleForget(params: unknown, env: Env): Promise<string> {
  const p = params as { memory_id: string; action: "compress" | "archive" | "delete"; reason?: string };

  const memory = await getMemory(env.TAPROOT_KV, p.memory_id);
  if (!memory) {
    return JSON.stringify({ status: "error", message: `Memory ${p.memory_id} not found` }, null, 2);
  }

  if (p.action === "delete") {
    await env.TAPROOT_KV.delete(`mem:${p.memory_id}`);
    return JSON.stringify({ status: "ok", action: "deleted", memory_id: p.memory_id }, null, 2);
  }

  // compress / archive: tag the memory for the Phase 3 compression engine
  const pendingTag = p.action === "compress" ? "_compress_pending" : "_archive_pending";
  if (!memory.tags.includes(pendingTag)) {
    memory.tags.push(pendingTag);
  }
  if (p.action === "compress") {
    memory.salience = "low";
  }
  memory.updated_at = new Date().toISOString();
  await putMemory(env.TAPROOT_KV, memory);

  return JSON.stringify({
    status: "ok",
    action: p.action,
    memory_id: p.memory_id,
    note: `Marked for ${p.action}. The compression engine will process this in Phase 3.`,
  }, null, 2);
}

async function handleTranscript(_params: unknown, _env: Env): Promise<string> {
  return JSON.stringify({
    status: "not_implemented",
    note: "Transcript archive is Phase 2.",
    results: [],
  }, null, 2);
}

async function handleStatus(_params: unknown, env: Env): Promise<string> {
  const allKeys = await listMemoryKeys(env.TAPROOT_KV);

  const counts: Record<MemoryCategory, number> = {
    identity: 0,
    relationship: 0,
    active_thread: 0,
    episodic: 0,
    error: 0,
  };
  let compressionQueue = 0;

  for (const k of allKeys) {
    const cat = k.metadata?.category;
    if (cat && cat in counts) counts[cat]++;
    if (k.metadata?.tags.some(t => t === "_compress_pending" || t === "_archive_pending")) {
      compressionQueue++;
    }
  }

  return JSON.stringify({
    status: "operational",
    phase: "1",
    storage: "connected",
    memory_counts: counts,
    total_memories: allKeys.length,
    compression_queue: compressionQueue,
  }, null, 2);
}

// ─── MCP Protocol Dispatch ────────────────────────────────────────────────────

function jsonOk(id: string | number | null, result: unknown): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(id: string | number | null, code: number, message: string): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  // No auth check here — the OAuth provider validates the access token
  // before this handler is ever invoked.
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonErr(null, -32700, "Parse error");
  }

  const id = body.id ?? null;

  switch (body.method) {
    case "initialize":
      return jsonOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      return new Response(null, { status: 204 });

    case "ping":
      return jsonOk(id, {});

    case "tools/list":
      return jsonOk(id, { tools: TOOLS });

    case "tools/call": {
      const p = body.params as { name: string; arguments?: unknown } | undefined;
      if (!p?.name) return jsonErr(id, -32602, "Missing tool name");

      const args = p.arguments ?? {};
      let result: string;

      try {
        switch (p.name) {
          case "taproot_reflect":   result = await handleReflect(args, env); break;
          case "taproot_remember":  result = await handleRemember(args, env); break;
          case "taproot_recall":    result = await handleRecall(args, env); break;
          case "taproot_forget":    result = await handleForget(args, env); break;
          case "taproot_transcript":result = await handleTranscript(args, env); break;
          case "taproot_status":    result = await handleStatus(args, env); break;
          default:
            return jsonErr(id, -32601, `Unknown tool: ${p.name}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Internal error";
        return jsonErr(id, -32603, msg);
      }

      return jsonOk(id, { content: [{ type: "text", text: result }] });
    }

    default:
      return jsonErr(id, -32601, `Method not found: ${body.method}`);
  }
}

// ─── API Handler (authenticated requests) ───────────────────────────────────
// The OAuth provider validates the access token before calling this.

class TaprootApiHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMcp(request, this.env);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── Default Handler (/health, /authorize, unknown routes) ──────────────────

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Unauthenticated health check
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok", server: SERVER_INFO }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // OAuth authorization flow — password-gated consent screen.
    if (url.pathname === "/authorize") {
      if (request.method === "GET") {
        const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
        return renderLoginForm(oauthReqInfo, clientInfo);
      }

      if (request.method === "POST") {
        const formData = await request.formData();
        const password = formData.get("password");
        const oauthReqEncoded = formData.get("oauth_req");

        if (typeof password !== "string" || typeof oauthReqEncoded !== "string") {
          return new Response("Bad request", { status: 400 });
        }

        let oauthReqInfo: AuthRequest;
        try {
          oauthReqInfo = JSON.parse(atob(oauthReqEncoded)) as AuthRequest;
        } catch {
          return new Response("Invalid oauth_req payload", { status: 400 });
        }

        if (password !== env.TAPROOT_AUTH_TOKEN) {
          const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
          return renderLoginForm(oauthReqInfo, clientInfo, "Incorrect auth token.");
        }

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: "james",
          metadata: { label: "Taproot single-user grant" },
          scope: oauthReqInfo.scope,
          props: { userId: "james" },
        });

        return Response.redirect(redirectTo, 302);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};

// ─── Consent Screen UI ──────────────────────────────────────────────────────

function renderLoginForm(
  oauthReqInfo: AuthRequest,
  clientInfo: ClientInfo | null,
  errorMsg?: string,
): Response {
  const encoded = btoa(JSON.stringify(oauthReqInfo));
  const clientName = clientInfo?.clientName ?? "An unknown client";
  const clientUri = clientInfo?.clientUri;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Taproot — Authorize</title>
  <style>
    body {
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      max-width: 480px;
      margin: 80px auto;
      padding: 20px;
      background: #fafafa;
      color: #222;
    }
    h1 { font-weight: 500; margin-bottom: 4px; }
    p { color: #555; line-height: 1.5; }
    .client { font-weight: 600; color: #222; }
    form { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; }
    input[type="password"] {
      padding: 10px 12px;
      font-size: 16px;
      border: 1px solid #ccc;
      border-radius: 6px;
      font-family: inherit;
    }
    button {
      padding: 10px 12px;
      font-size: 16px;
      border: none;
      background: #1a1a1a;
      color: white;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
    }
    button:hover { background: #444; }
    .error { color: #b00020; margin-top: 4px; font-size: 14px; }
    .subtitle { color: #888; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Taproot</h1>
  <p><span class="client">${escapeHtml(clientName)}</span> is requesting access to your memory store.</p>
  ${clientUri ? `<p class="subtitle">${escapeHtml(clientUri)}</p>` : ""}
  <form method="POST" action="/authorize">
    <input type="password" name="password" placeholder="Auth token" required autofocus />
    <input type="hidden" name="oauth_req" value="${escapeHtml(encoded)}" />
    <button type="submit">Authorize</button>
    ${errorMsg ? `<div class="error">${escapeHtml(errorMsg)}</div>` : ""}
  </form>
</body>
</html>`;

  return new Response(html, {
    status: errorMsg ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── OAuth Provider (default export) ─────────────────────────────────────────

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: TaprootApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
