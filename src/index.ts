// Taproot MCP Server — Cloudflare Worker
// Phase 1 scaffold: all tools are stubbed, KV not yet wired.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  TAPROOT_KV: KVNamespace;
  TAPROOT_AUTH_TOKEN: string;
}

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

// ─── Stub Tool Handlers ───────────────────────────────────────────────────────
// Each returns a JSON string. Replace stubs with real KV logic in Phase 1.

async function handleReflect(_params: unknown, _env: Env): Promise<string> {
  return JSON.stringify({
    status: "stub",
    note: "KV storage not yet wired. This is the Phase 1 scaffold.",
    identity_observations: [],
    relationship_texture: [],
    active_threads: [],
    error_log: [],
  }, null, 2);
}

async function handleRemember(params: unknown, _env: Env): Promise<string> {
  const p = params as {
    category: string;
    content: string;
    salience?: string;
    tags?: string[];
    linked_memories?: string[];
    update_id?: string;
  };
  return JSON.stringify({
    status: "stub",
    note: "Memory received but NOT persisted — KV not yet wired.",
    would_write: {
      id: crypto.randomUUID(),
      category: p.category,
      content: p.content,
      salience: p.salience ?? "medium",
      tags: p.tags ?? [],
    },
  }, null, 2);
}

async function handleRecall(params: unknown, _env: Env): Promise<string> {
  return JSON.stringify({
    status: "stub",
    note: "KV not yet wired.",
    query_received: params,
    results: [],
  }, null, 2);
}

async function handleForget(params: unknown, _env: Env): Promise<string> {
  const p = params as { memory_id: string; action: string; reason?: string };
  return JSON.stringify({
    status: "stub",
    note: "Action received but NOT applied — KV not yet wired.",
    memory_id: p.memory_id,
    action: p.action,
  }, null, 2);
}

async function handleTranscript(_params: unknown, _env: Env): Promise<string> {
  return JSON.stringify({
    status: "stub",
    note: "Transcript archive not yet implemented (Phase 2).",
    results: [],
  }, null, 2);
}

async function handleStatus(_params: unknown, _env: Env): Promise<string> {
  return JSON.stringify({
    status: "operational",
    phase: "scaffold",
    storage: "not_yet_wired",
    memory_counts: { identity: 0, relationship: 0, active_thread: 0, episodic: 0, error: 0 },
    total_memories: 0,
    note: "Taproot is running. KV storage not yet connected.",
  }, null, 2);
}

// ─── MCP Protocol ─────────────────────────────────────────────────────────────

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

// ─── Worker Entry Point ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated health check
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok", server: SERVER_INFO }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // All other routes require bearer token
    const auth = request.headers.get("Authorization");
    if (!auth || auth !== `Bearer ${env.TAPROOT_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMcp(request, env);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
