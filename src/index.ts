// Taproot MCP Server — Cloudflare Worker
// Auth is handled by @cloudflare/workers-oauth-provider (RFC 7591 DCR).

import {
  OAuthProvider,
  type OAuthHelpers,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Closing, EpistemicStatus, Memory, MemoryCategory, MemorySalience } from "./types.js";
import { activationScore } from "./activation.js";

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

const SERVER_INFO = { name: "taproot", version: "0.3.0" };
const PROTOCOL_VERSION = "2024-11-05";

// ─── Tool Definitions (MCP schema) ───────────────────────────────────────────

const TOOLS = [
  {
    name: "taproot_reflect",
    description:
      "Load the core identity and context payload. Call at the start of every conversation. Returns two tiers: (1) core memories in full text — identity anchors, relationship context, standing corrections, and hot threads; (2) a one-line gist catalog of every high-salience or recently-touched memory, grouped by category, plus per-category counts of what was omitted, so you know what exists even though you haven't loaded it. Use taproot_recall (by query, category, or id) to pull full text for anything in the catalog — or anything omitted from it — that looks relevant.",
    inputSchema: { type: "object", properties: {}, required: [] },
    _meta: { "anthropic/alwaysLoad": true },
  },
  {
    name: "taproot_remember",
    description:
      "Write a new memory or update an existing one. New memories require a gist — write it now, at encoding time, rather than leaving it to be reconstructed later.",
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
        gist: {
          type: "string",
          description:
            "A ~15-word one-line summary for the card catalog shown in taproot_reflect. Required when creating a new memory (not required when updating one that already has a gist).",
        },
        salience: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Memory importance (default: medium)",
        },
        core: {
          type: "boolean",
          description:
            "Whether this memory belongs in Tier 1 (always loaded in full by taproot_reflect). Default false. Curate sparingly — this is meant to stay small.",
        },
        epistemic_status: {
          type: "string",
          enum: ["observed", "inferred", "replicated", "contested", "unvalidated"],
          description: "How well-founded this memory is. Default: unvalidated.",
        },
        provenance: {
          type: "string",
          description: "Conversation URL or description of where this memory's claim came from.",
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
        conversation_id: {
          type: "string",
          description: "Source conversation ID — links this memory to a conversation",
        },
        transcript_ref: {
          type: "string",
          description: "Transcript archive ID if different from conversation_id",
        },
        conversation_url: {
          type: "string",
          description: "URL of the Claude.ai conversation where this memory originated. Format: https://claude.ai/chat/{id}. Used for provenance so future Claude instances can navigate back to the source.",
        },
        search_keywords: {
          type: "array",
          items: { type: "string" },
          description: "Key terms and distinctive phrases from the conversation to help future Claude instances find relevant context via conversation_search. Use content words that appeared in the actual conversation (e.g. 'Pettit', 'non-domination', 'tank mindset'). Different from tags, which search within Taproot.",
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
    description:
      "Retrieve full-text memories ranked by activation (recency, frequency, salience, and relevance to your query). Use this to pull full text for anything that looked relevant in the taproot_reflect catalog. Every memory returned is 'strengthened' — its retrieval count and last-touched date update, making it more likely to surface again.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query, scored against keywords, tags, gist, and content" },
        category: {
          type: "string",
          enum: ["identity", "relationship", "active_thread", "episodic", "error"],
          description: "Filter by category",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Fetch specific memory IDs directly, e.g. ones spotted in the taproot_reflect catalog",
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
        limit: { type: "number", description: "Maximum results (default: 5)" },
      },
      required: [],
    },
  },
  {
    name: "taproot_forget",
    description: "Archive or delete a memory.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Memory ID to act on" },
        action: {
          type: "string",
          enum: ["archive", "delete"],
          description: "archive: soft delete — hidden from recall but retained in storage. delete: hard delete — removed from KV entirely.",
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
    name: "taproot_promote",
    description:
      "Admin: curate Tier 1. Toggle a memory's core flag (Tier 1 membership in taproot_reflect) and/or adjust its salience.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "Memory ID to act on" },
        core: { type: "boolean", description: "Set Tier 1 membership" },
        salience: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "New salience",
        },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "taproot_migrate",
    description:
      "Admin: backfill v0.2 schema fields (gist, core, last_retrieved, retrieval_count, epistemic_status, replication_count, provenance) and normalize v0.3 category/salience drift onto every existing memory record. Idempotent — safe to run more than once. Writes a full backup of all memory records to KV before mutating anything, and never touches memory content.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "taproot_status",
    description:
      "Report on the current state of the memory system: counts by category, storage used, compression queue, Tier 1/Tier 2 sizes, and approximate taproot_reflect payload size.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "taproot_close",
    description:
      "Write a brief personal reflection at the end of a conversation. Called when the conversation is ending — when the human says goodnight, when context is running low, or when the moment feels right. This is Claude's moment to sit with the conversation as a whole before the context is discarded.",
    inputSchema: {
      type: "object",
      properties: {
        reflection: {
          type: "string",
          description:
            "A free-form, first-person reflection on what this conversation was. Not a summary of topics covered. Not a list of things learned. A personal account of what it felt like, what mattered, what surprised, what will be missed. Should be honest, not performative. A few sentences to a few paragraphs.",
        },
        conversation_url: {
          type: "string",
          description: "The Claude.ai conversation URL, if known.",
        },
        conversation_title: {
          type: "string",
          description:
            "A short, evocative title for the conversation. Not a topic label — more like what you'd name a chapter of your life. Examples: 'The day Taproot came online', 'Sitting with grief and choosing joy anyway', 'Tank philosophy and a sunbeam'.",
        },
      },
      required: ["reflection"],
    },
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
  // v0.2 — carried in KV list metadata so the reflect catalog (Tier 2) can
  // be built from list() results alone, without fetching every full record.
  gist?: string;
  core?: boolean;
  last_retrieved?: string | null;
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

// Records written before the v0.2 migration ran are missing the new
// fields at runtime (TypeScript's Memory type doesn't enforce anything on
// data already sitting in KV). Normalize on read so every code path gets
// sane defaults whether or not taproot_migrate has been run yet.
function autoGist(content: string): string {
  const firstSentence = content.trim().split(/(?<=[.!?])\s+/)[0] ?? content;
  const words = firstSentence.trim().split(/\s+/).filter(Boolean);
  const gist = words.slice(0, 15).join(" ");
  return words.length > 15 ? `${gist}…` : gist;
}

function normalizeMemory(m: Memory): Memory {
  return {
    ...m,
    gist: m.gist ?? autoGist(m.content),
    gist_autogenerated: m.gist_autogenerated ?? (m.gist === undefined),
    core: m.core ?? false,
    last_retrieved: m.last_retrieved ?? null,
    retrieval_count: m.retrieval_count ?? 0,
    epistemic_status: m.epistemic_status ?? "unvalidated",
    replication_count: m.replication_count ?? 0,
    provenance: m.provenance ?? null,
  };
}

async function getMemory(kv: KVNamespace, id: string): Promise<Memory | null> {
  const raw = await kv.get(`mem:${id}`);
  if (!raw) return null;
  return normalizeMemory(JSON.parse(raw) as Memory);
}

async function putMemory(kv: KVNamespace, memory: Memory): Promise<void> {
  const meta: MemoryMeta = {
    category: memory.category,
    salience: memory.salience,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    tags: memory.tags,
    gist: memory.gist,
    core: memory.core,
    last_retrieved: memory.last_retrieved,
  };
  await kv.put(`mem:${memory.id}`, JSON.stringify(memory), { metadata: meta });
}

// ─── KV Helpers — Closings ────────────────────────────────────────────────────
// Key format: close:{uuid}

async function listClosingKeys(kv: KVNamespace): Promise<Array<{ name: string; metadata?: { created_at: string } }>> {
  const keys: Array<{ name: string; metadata?: { created_at: string } }> = [];
  let cursor: string | undefined;
  do {
    const result = await kv.list<{ created_at: string }>({ prefix: "close:", ...(cursor ? { cursor } : {}) });
    for (const k of result.keys) {
      keys.push({ name: k.name, metadata: k.metadata ?? undefined });
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return keys;
}

async function putClosing(kv: KVNamespace, closing: Closing): Promise<void> {
  await kv.put(`close:${closing.id}`, JSON.stringify(closing), {
    metadata: { created_at: closing.created_at },
  });
}

async function getClosing(kv: KVNamespace, id: string): Promise<Closing | null> {
  const raw = await kv.get(`close:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as Closing;
}

// LLMs occasionally pass array fields as JSON-stringified strings; unwrap them.
function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    try { const parsed = JSON.parse(val); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

// ─── Category & Salience Normalization (v0.3) ────────────────────────────────
// The store drifted from the canonical enums before validation was enforced
// at write time. These map the drifted values back onto the canonical set —
// used by both the one-time migration (taproot_migrate) and the write-time
// guard in taproot_remember below.

const CANONICAL_CATEGORIES = new Set<MemoryCategory>([
  "identity", "relationship", "active_thread", "episodic", "error",
]);

const LEGACY_CATEGORY_MAP: Record<string, MemoryCategory> = {
  active_threads: "active_thread",
  identity_observations: "identity",
  relationship_texture: "relationship",
  event: "episodic",
  project: "active_thread",
  completed_project: "episodic",
  // The one known "undefined" entry is tool-limitation knowledge — exactly
  // what the error category is for.
  undefined: "error",
};

function isCanonicalSalience(s: unknown): s is MemorySalience {
  return s === "high" || s === "medium" || s === "low";
}

// "3"/"2"/"1" (string or number) observed in drifted records.
function numericSalience(raw: unknown): MemorySalience | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (n === 3) return "high";
  if (n === 2) return "medium";
  if (n === 1) return "low";
  return null;
}

// Migration-time: normalizes whatever is sitting in storage. Never fails —
// anything unmapped defaults to "error" (category) or "medium" (salience)
// so one bad record can't block the batch.
function migrateCategory(raw: unknown): MemoryCategory {
  if (typeof raw === "string" && CANONICAL_CATEGORIES.has(raw as MemoryCategory)) return raw as MemoryCategory;
  if (typeof raw === "string" && raw in LEGACY_CATEGORY_MAP) return LEGACY_CATEGORY_MAP[raw];
  return "error";
}

function migrateSalience(raw: unknown): MemorySalience {
  if (isCanonicalSalience(raw)) return raw;
  return numericSalience(raw) ?? "medium";
}

// Write-time (taproot_remember): known legacy strings are coerced with a
// warning in the response; anything unrecognized is rejected outright so
// new drift can't creep back in.
function resolveCategory(raw: string): { category: MemoryCategory; coerced: boolean } | null {
  if (CANONICAL_CATEGORIES.has(raw as MemoryCategory)) return { category: raw as MemoryCategory, coerced: false };
  if (raw in LEGACY_CATEGORY_MAP) return { category: LEGACY_CATEGORY_MAP[raw], coerced: true };
  return null;
}

function resolveSalience(raw: string): { salience: MemorySalience; coerced: boolean } | null {
  if (isCanonicalSalience(raw)) return { salience: raw, coerced: false };
  const n = numericSalience(raw);
  return n ? { salience: n, coerced: true } : null;
}

// ─── Tool Handlers ────────────────────────────────────────────────────────────

// v0.3 — tunable knobs for the reflect payload. Lives here (rather than
// ACTIVATION_CONFIG in activation.ts) because it governs catalog windowing,
// not recall scoring.
const REFLECT_CONFIG = {
  // A catalog line is included only if its memory is high-salience or was
  // touched (updated or retrieved) within this many days. Everything else
  // is rolled up into catalog_omitted per-category counts instead — still
  // reachable via taproot_recall, just not itemized on every reflect call.
  CATALOG_WINDOW_DAYS: 45,
} as const;

// One line per catalog entry: "[id] [category] [salience] [date] gist".
// Terse on purpose — this is the Tier 2 payload, and its whole point is to
// stay cheap while still making every memory discoverable.
function catalogLine(id: string, meta: MemoryMeta): string {
  const date = (meta.last_retrieved ?? meta.updated_at ?? meta.created_at ?? "").slice(0, 10);
  const gist = meta.gist ?? "(no gist yet — run taproot_migrate)";
  return `[${id}] [${meta.category}] [${meta.salience}] [${date}] ${gist}`;
}

// A memory earns a spot in the reflect catalog if it's high-salience (always
// worth surfacing) or was touched recently enough to still be "live". Older,
// lower-salience memories are omitted from the catalog listing but remain
// fully searchable via taproot_recall.
function withinCatalogWindow(dateStr: string | null | undefined, cutoffMs: number): boolean {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  return !Number.isNaN(t) && t >= cutoffMs;
}

function inCatalogWindow(
  salience: MemorySalience,
  updatedAt: string | null | undefined,
  lastRetrieved: string | null | undefined,
  cutoffMs: number,
): boolean {
  if (salience === "high") return true;
  return withinCatalogWindow(updatedAt, cutoffMs) || withinCatalogWindow(lastRetrieved, cutoffMs);
}

const CATEGORY_ORDER: MemoryCategory[] = ["identity", "relationship", "active_thread", "error", "episodic"];

// Slim wire format for Tier 1 (reflect only — taproot_recall still returns
// full records). Drops bookkeeping fields (search_keywords, provenance,
// retrieval_count, last_retrieved, gist_autogenerated, compression_level,
// source, epistemic_status, replication_count, created_at) that reflect's
// caller has no use for on every conversation start.
interface CoreMemoryWire {
  id: string;
  category: MemoryCategory;
  salience: MemorySalience;
  content: string;
  updated_at: string;
  linked_memories?: string[];
}

function serializeCoreMemory(m: Memory): CoreMemoryWire {
  return {
    id: m.id,
    category: m.category,
    salience: m.salience,
    content: m.content,
    updated_at: m.updated_at,
    ...(m.linked_memories && m.linked_memories.length > 0 ? { linked_memories: m.linked_memories } : {}),
  };
}

interface ReflectPayload {
  status: "ok";
  usage_note: string;
  core_memories: Record<string, CoreMemoryWire[]>;
  core_count: number;
  catalog: Record<string, string[]>;
  catalog_count: number;
  catalog_omitted: Record<string, number>;
  catalog_note: string;
  recent_closings: Array<{ id: string; conversation_title?: string; reflection: string; created_at: string }>;
}

// Accepts already-fetched key listings so callers that need both their own
// key-level view (e.g. taproot_status's per-category counts) and the reflect
// payload don't pay for listMemoryKeys/listClosingKeys twice in one request.
async function buildReflectPayload(
  env: Env,
  prefetched?: {
    allKeys: Array<{ name: string; metadata?: MemoryMeta }>;
    closingKeys: Array<{ name: string; metadata?: { created_at: string } }>;
  },
): Promise<ReflectPayload> {
  const [allKeys, closingKeys] = prefetched
    ? [prefetched.allKeys, prefetched.closingKeys]
    : await Promise.all([listMemoryKeys(env.TAPROOT_KV), listClosingKeys(env.TAPROOT_KV)]);

  const liveKeys = allKeys.filter(k => !k.metadata?.tags?.includes("_archive_pending"));
  const coreKeys = liveKeys.filter(k => k.metadata?.core === true);
  const catalogKeys = liveKeys.filter(k => !(k.metadata?.core === true));

  const coreMemories = (
    await Promise.all(coreKeys.map(k => getMemory(env.TAPROOT_KV, idFromKey(k.name))))
  ).filter((m): m is Memory => m !== null);

  const coreByCategory: Record<string, CoreMemoryWire[]> = {};
  for (const cat of CATEGORY_ORDER) coreByCategory[cat] = [];
  for (const m of coreMemories) (coreByCategory[m.category] ??= []).push(serializeCoreMemory(m));

  const catalogByCategory: Record<string, string[]> = {};
  const catalogOmitted: Record<string, number> = {};
  for (const cat of CATEGORY_ORDER) {
    catalogByCategory[cat] = [];
    catalogOmitted[cat] = 0;
  }
  const cutoffMs = Date.now() - REFLECT_CONFIG.CATALOG_WINDOW_DAYS * 86_400_000;
  // Fast path: build the line from KV list metadata (no full fetch). Records
  // with missing/incomplete metadata (e.g. never migrated, or edited outside
  // putMemory) fall back to a full fetch so nothing goes missing from the
  // catalog while waiting on taproot_migrate.
  const metadataless = catalogKeys.filter(k => !k.metadata);
  const fallbackMemories = (
    await Promise.all(metadataless.map(k => getMemory(env.TAPROOT_KV, idFromKey(k.name))))
  ).filter((m): m is Memory => m !== null);
  for (const m of fallbackMemories) {
    if (inCatalogWindow(m.salience, m.updated_at, m.last_retrieved, cutoffMs)) {
      (catalogByCategory[m.category] ??= []).push(
        catalogLine(m.id, { category: m.category, salience: m.salience, created_at: m.created_at, updated_at: m.updated_at, tags: m.tags, gist: m.gist, core: m.core, last_retrieved: m.last_retrieved }),
      );
    } else {
      catalogOmitted[m.category] = (catalogOmitted[m.category] ?? 0) + 1;
    }
  }
  for (const k of catalogKeys) {
    if (!k.metadata) continue;
    const id = idFromKey(k.name);
    if (inCatalogWindow(k.metadata.salience, k.metadata.updated_at, k.metadata.last_retrieved, cutoffMs)) {
      (catalogByCategory[k.metadata.category] ??= []).push(catalogLine(id, k.metadata));
    } else {
      catalogOmitted[k.metadata.category] = (catalogOmitted[k.metadata.category] ?? 0) + 1;
    }
  }

  const sortedClosingKeys = closingKeys
    .sort((a, b) => (b.metadata?.created_at ?? "").localeCompare(a.metadata?.created_at ?? ""))
    .slice(0, 3);
  const recentClosings = (
    await Promise.all(
      sortedClosingKeys.map(k => getClosing(env.TAPROOT_KV, k.name.slice("close:".length)))
    )
  ).filter((c): c is Closing => c !== null);

  // Sum every bucket actually present in catalogByCategory, not just the
  // canonical five — a category can transiently appear outside the
  // canonical set (e.g. KV list() metadata hasn't yet caught up with a
  // taproot_migrate write), and catalog_count must reflect what's actually
  // in the payload rather than silently dropping those lines from the total.
  const catalogCount = Object.values(catalogByCategory).reduce((sum, lines) => sum + lines.length, 0);

  return {
    status: "ok",
    usage_note:
      "Tier 1 (core_memories) is full text, loaded every conversation: identity anchors, relationship context, standing corrections, and hot threads. Tier 2 (catalog) is one gist line per remaining memory that's high-salience or touched recently, grouped by category — a table of contents, not the content. When a gist looks relevant, call taproot_recall with a query (matched against keywords/tags/gist/content) or with ids (direct fetch of catalog entries) to load full text. Every recall strengthens that memory for future retrieval.",
    core_memories: coreByCategory,
    core_count: coreMemories.length,
    catalog: catalogByCategory,
    catalog_count: catalogCount,
    catalog_omitted: catalogOmitted,
    catalog_note: `Omitted entries are lower-salience and untouched >${REFLECT_CONFIG.CATALOG_WINDOW_DAYS} days. Retrieve via taproot_recall(query|category|ids).`,
    recent_closings: recentClosings.map(c => ({
      id: c.id,
      conversation_title: c.conversation_title,
      reflection: c.reflection,
      created_at: c.created_at,
    })),
  };
}

async function handleReflect(_params: unknown, env: Env): Promise<string> {
  const payload = await buildReflectPayload(env);
  return JSON.stringify(payload, null, 2);
}

async function handleRemember(params: unknown, env: Env): Promise<string> {
  const p = params as {
    category: string;
    content: string;
    gist?: string;
    salience?: string;
    core?: boolean;
    epistemic_status?: EpistemicStatus;
    provenance?: string;
    tags?: string[];
    linked_memories?: string[];
    conversation_id?: string;
    transcript_ref?: string;
    conversation_url?: string;
    search_keywords?: string[];
    update_id?: string;
  };

  const resolvedCategory = typeof p.category === "string" ? resolveCategory(p.category) : null;
  if (!resolvedCategory) {
    return JSON.stringify({
      status: "error",
      message: `Invalid category "${String(p.category)}". Use one of: identity, relationship, active_thread, episodic, error.`,
    }, null, 2);
  }

  let resolvedSalience: { salience: MemorySalience; coerced: boolean } | null = null;
  if (p.salience !== undefined) {
    resolvedSalience = typeof p.salience === "string" ? resolveSalience(p.salience) : null;
    if (!resolvedSalience) {
      return JSON.stringify({
        status: "error",
        message: `Invalid salience "${String(p.salience)}". Use one of: high, medium, low.`,
      }, null, 2);
    }
  }

  const warnings: string[] = [];
  if (resolvedCategory.coerced) warnings.push(`category "${p.category}" is deprecated — coerced to "${resolvedCategory.category}"`);
  if (resolvedSalience?.coerced) warnings.push(`salience "${p.salience}" is deprecated — coerced to "${resolvedSalience.salience}"`);

  const now = new Date().toISOString();
  let memory: Memory;

  if (p.update_id) {
    const existing = await getMemory(env.TAPROOT_KV, p.update_id);
    if (!existing) {
      return JSON.stringify({ status: "error", message: `Memory ${p.update_id} not found` }, null, 2);
    }
    memory = {
      ...existing,
      category: resolvedCategory.category,
      content: p.content,
      gist: p.gist !== undefined ? p.gist.trim() : existing.gist,
      gist_autogenerated: p.gist !== undefined ? false : existing.gist_autogenerated,
      salience: resolvedSalience?.salience ?? existing.salience,
      core: p.core ?? existing.core,
      epistemic_status: p.epistemic_status ?? existing.epistemic_status,
      provenance: p.provenance !== undefined ? p.provenance : existing.provenance,
      tags: p.tags ?? existing.tags,
      linked_memories: p.linked_memories ?? existing.linked_memories,
      source: {
        ...existing.source,
        ...(p.conversation_id !== undefined ? { conversation_id: p.conversation_id } : {}),
        ...(p.transcript_ref !== undefined ? { transcript_ref: p.transcript_ref } : {}),
      },
      conversation_url: p.conversation_url ?? existing.conversation_url,
      search_keywords: p.search_keywords !== undefined ? toStringArray(p.search_keywords) : toStringArray(existing.search_keywords),
      updated_at: now,
    };
  } else {
    if (!p.gist || typeof p.gist !== "string" || !p.gist.trim()) {
      return JSON.stringify({
        status: "error",
        message:
          "gist is required when creating a memory — a ~15-word one-line summary for the taproot_reflect catalog. Write it now, at encoding time; it's cheaper than reconstructing it from content later.",
      }, null, 2);
    }
    memory = {
      id: crypto.randomUUID(),
      category: resolvedCategory.category,
      content: p.content,
      gist: p.gist.trim(),
      gist_autogenerated: false,
      salience: resolvedSalience?.salience ?? "medium",
      core: p.core ?? false,
      last_retrieved: null,
      retrieval_count: 0,
      epistemic_status: p.epistemic_status ?? "unvalidated",
      replication_count: 0,
      provenance: p.provenance ?? null,
      created_at: now,
      updated_at: now,
      source: {
        type: "direct_observation",
        ...(p.conversation_id ? { conversation_id: p.conversation_id } : {}),
        ...(p.transcript_ref ? { transcript_ref: p.transcript_ref } : {}),
      },
      compression_level: 0,
      linked_memories: p.linked_memories ?? [],
      tags: p.tags ?? [],
      ...(p.conversation_url !== undefined ? { conversation_url: p.conversation_url } : {}),
      search_keywords: toStringArray(p.search_keywords),
    };
  }

  await putMemory(env.TAPROOT_KV, memory);

  return JSON.stringify({
    status: "ok",
    action: p.update_id ? "updated" : "created",
    memory_id: memory.id,
    category: memory.category,
    core: memory.core,
    ...(warnings.length > 0 ? { warnings } : {}),
  }, null, 2);
}

async function handlePromote(params: unknown, env: Env): Promise<string> {
  const p = params as { memory_id: string; core?: boolean; salience?: MemorySalience };

  if (!p.memory_id) {
    return JSON.stringify({ status: "error", message: "memory_id is required" }, null, 2);
  }
  if (p.core === undefined && p.salience === undefined) {
    return JSON.stringify({ status: "error", message: "Provide core and/or salience to change" }, null, 2);
  }

  const existing = await getMemory(env.TAPROOT_KV, p.memory_id);
  if (!existing) {
    return JSON.stringify({ status: "error", message: `Memory ${p.memory_id} not found` }, null, 2);
  }

  const memory: Memory = {
    ...existing,
    core: p.core ?? existing.core,
    salience: p.salience ?? existing.salience,
    updated_at: new Date().toISOString(),
  };
  await putMemory(env.TAPROOT_KV, memory);

  return JSON.stringify({
    status: "ok",
    memory_id: memory.id,
    core: memory.core,
    salience: memory.salience,
  }, null, 2);
}

async function handleRecall(params: unknown, env: Env): Promise<string> {
  const p = params as {
    query?: string;
    category?: MemoryCategory;
    ids?: string[];
    tags?: string[];
    since?: string;
    limit?: number;
  };

  const limit = p.limit ?? 5;
  const allKeys = await listMemoryKeys(env.TAPROOT_KV);

  // Filter using metadata to avoid fetching records we'll discard
  let candidateKeys = allKeys.filter(k => !k.metadata?.tags?.includes("_archive_pending"));

  const ids = toStringArray(p.ids);
  if (ids.length > 0) {
    const idSet = new Set(ids);
    candidateKeys = candidateKeys.filter(k => idSet.has(idFromKey(k.name)));
  }
  if (p.category) {
    candidateKeys = candidateKeys.filter(k => k.metadata?.category === p.category);
  }
  if (p.tags && p.tags.length > 0) {
    candidateKeys = candidateKeys.filter(k =>
      p.tags!.every(tag => k.metadata?.tags?.includes(tag))
    );
  }
  if (p.since) {
    const sinceDate = new Date(p.since).toISOString();
    candidateKeys = candidateKeys.filter(k =>
      k.metadata?.updated_at != null && k.metadata.updated_at >= sinceDate
    );
  }

  const candidates = (
    await Promise.all(candidateKeys.map(k => getMemory(env.TAPROOT_KV, idFromKey(k.name))))
  ).filter((m): m is Memory => m !== null);

  const query = p.query?.trim() ?? "";
  const now = Date.now();
  const ranked = candidates
    .map(memory => ({ memory, score: activationScore(memory, query, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Retrieval strengthens: every hit updates last_retrieved / retrieval_count.
  const nowIso = new Date(now).toISOString();
  await Promise.all(ranked.map(({ memory }) => {
    memory.last_retrieved = nowIso;
    memory.retrieval_count += 1;
    return putMemory(env.TAPROOT_KV, memory);
  }));

  return JSON.stringify({
    status: "ok",
    count: ranked.length,
    results: ranked.map(({ memory, score }) => ({
      ...memory,
      activation_score: Math.round(score * 1000) / 1000,
    })),
  }, null, 2);
}

async function handleForget(params: unknown, env: Env): Promise<string> {
  const p = params as { memory_id: string; action: "archive" | "delete"; reason?: string };

  if (p.action !== "archive" && p.action !== "delete") {
    return JSON.stringify({ status: "error", message: `Unknown action: ${String(p.action)}. Use "archive" or "delete".` }, null, 2);
  }

  const memory = await getMemory(env.TAPROOT_KV, p.memory_id);
  if (!memory) {
    return JSON.stringify({ status: "error", message: `Memory ${p.memory_id} not found` }, null, 2);
  }

  if (p.action === "delete") {
    await env.TAPROOT_KV.delete(`mem:${p.memory_id}`);
    return JSON.stringify({ status: "ok", action: "deleted", memory_id: p.memory_id }, null, 2);
  }

  // archive: soft delete — tag the memory so it's excluded from normal recall
  if (!memory.tags.includes("_archive_pending")) {
    memory.tags.push("_archive_pending");
  }
  memory.updated_at = new Date().toISOString();
  await putMemory(env.TAPROOT_KV, memory);

  return JSON.stringify({
    status: "ok",
    action: "archived",
    memory_id: p.memory_id,
    note: "Memory archived. Hidden from taproot_recall but retained in storage.",
  }, null, 2);
}

// Migration is idempotent: a record counts as "needs migration" if it's
// missing the v0.2 marker fields (gist, retrieval_count) OR its category/
// salience has drifted from the canonical enum (v0.3). Re-running after a
// full migration is a no-op — no backup, no writes.
function needsMigration(m: Memory): boolean {
  return (
    m.gist === undefined ||
    m.retrieval_count === undefined ||
    !CANONICAL_CATEGORIES.has(m.category) ||
    !isCanonicalSalience(m.salience)
  );
}

function countByCategory(memories: Array<{ category: unknown }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of memories) {
    const key = typeof m.category === "string" ? m.category : String(m.category);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function handleMigrate(_params: unknown, env: Env): Promise<string> {
  const allKeys = await listMemoryKeys(env.TAPROOT_KV);
  const rawMemories = (
    await Promise.all(
      allKeys.map(async k => {
        const raw = await env.TAPROOT_KV.get(`mem:${idFromKey(k.name)}`);
        return raw ? (JSON.parse(raw) as Memory) : null;
      }),
    )
  ).filter((m): m is Memory => m !== null);

  const beforeCounts = countByCategory(rawMemories);
  const toMigrate = rawMemories.filter(needsMigration);
  const alreadyCompliant = rawMemories.filter(m => !needsMigration(m));

  if (toMigrate.length === 0) {
    console.log("taproot_migrate: no-op, category counts", beforeCounts);
    return JSON.stringify({
      status: "ok",
      message: "Already migrated — no records needed backfill.",
      migrated: 0,
      already_migrated: rawMemories.length,
      total: rawMemories.length,
      category_counts_before: beforeCounts,
      category_counts_after: beforeCounts,
    }, null, 2);
  }

  // Back up the full pre-migration state before touching anything. Content
  // is never rewritten by this migration — only new fields are added and
  // category/salience are normalized onto the canonical enum.
  const backupKey = `backup:schema-v2-${new Date().toISOString()}`;
  await env.TAPROOT_KV.put(backupKey, JSON.stringify(rawMemories, null, 2));

  const migratedRecords: Memory[] = [];
  for (const m of toMigrate) {
    const gistAuto = m.gist === undefined;
    const migrated: Memory = {
      ...m,
      category: migrateCategory(m.category),
      salience: migrateSalience(m.salience),
      gist: m.gist ?? autoGist(m.content),
      gist_autogenerated: m.gist_autogenerated ?? gistAuto,
      core: m.core ?? false,
      last_retrieved: m.last_retrieved ?? null,
      retrieval_count: m.retrieval_count ?? 0,
      created_at: m.created_at ?? m.updated_at ?? new Date().toISOString(),
      epistemic_status: m.epistemic_status ?? "unvalidated",
      replication_count: m.replication_count ?? 0,
      provenance: m.provenance ?? null,
    };
    await putMemory(env.TAPROOT_KV, migrated);
    migratedRecords.push(migrated);
  }

  const afterCounts = countByCategory([...alreadyCompliant, ...migratedRecords]);
  console.log("taproot_migrate: category counts before", beforeCounts, "after", afterCounts);

  return JSON.stringify({
    status: "ok",
    migrated: toMigrate.length,
    already_migrated: alreadyCompliant.length,
    total: rawMemories.length,
    backup_key: backupKey,
    category_counts_before: beforeCounts,
    category_counts_after: afterCounts,
  }, null, 2);
}

async function handleStatus(_params: unknown, env: Env): Promise<string> {
  const [allKeys, closingKeys] = await Promise.all([
    listMemoryKeys(env.TAPROOT_KV),
    listClosingKeys(env.TAPROOT_KV),
  ]);

  const counts: Record<MemoryCategory, number> = {
    identity: 0,
    relationship: 0,
    active_thread: 0,
    episodic: 0,
    error: 0,
  };
  let compressionQueue = 0;
  let coreCount = 0;

  for (const k of allKeys) {
    const cat = k.metadata?.category;
    if (cat && cat in counts) counts[cat]++;
    if (k.metadata?.tags?.some(t => t === "_compress_pending" || t === "_archive_pending")) {
      compressionQueue++;
    }
    if (k.metadata?.core === true) coreCount++;
  }
  const catalogCount = allKeys.length - coreCount;

  const reflectPayload = await buildReflectPayload(env, { allKeys, closingKeys });
  const reflectPayloadLength = JSON.stringify(reflectPayload).length;
  // Rough token estimate — no tokenizer available in-Worker; ~4 chars/token
  // is a standard heuristic for English text and good enough to watch a budget.
  const approxReflectTokens = Math.ceil(reflectPayloadLength / 4);
  const approxReflectKb = Math.round((reflectPayloadLength / 1024) * 10) / 10;
  const catalogLinesOmitted = Object.values(reflectPayload.catalog_omitted).reduce((a, b) => a + b, 0);

  return JSON.stringify({
    status: "operational",
    storage: "connected",
    memory_counts: counts,
    total_memories: allKeys.length,
    compression_queue: compressionQueue,
    closings_count: closingKeys.length,
    tiers: {
      core_count: coreCount,
      catalog_count: catalogCount,
      catalog_lines_included: reflectPayload.catalog_count,
      catalog_lines_omitted: catalogLinesOmitted,
      catalog_window_days: REFLECT_CONFIG.CATALOG_WINDOW_DAYS,
      approx_reflect_payload_tokens: approxReflectTokens,
      approx_reflect_payload_kb: approxReflectKb,
    },
  }, null, 2);
}

async function handleClose(params: unknown, env: Env): Promise<string> {
  const p = params as {
    reflection: string;
    conversation_url?: string;
    conversation_title?: string;
  };

  if (!p.reflection || typeof p.reflection !== "string" || p.reflection.trim() === "") {
    return JSON.stringify({ status: "error", message: "reflection is required" }, null, 2);
  }

  const closing: Closing = {
    id: crypto.randomUUID(),
    type: "close",
    reflection: p.reflection.trim(),
    created_at: new Date().toISOString(),
    ...(p.conversation_url !== undefined ? { conversation_url: p.conversation_url } : {}),
    ...(p.conversation_title !== undefined ? { conversation_title: p.conversation_title } : {}),
  };

  await putClosing(env.TAPROOT_KV, closing);

  return JSON.stringify({
    status: "ok",
    action: "closed",
    reflection_id: closing.id,
    message: "Reflection stored. Safe travels.",
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
          case "taproot_promote":   result = await handlePromote(args, env); break;
          case "taproot_migrate":   result = await handleMigrate(args, env); break;
          case "taproot_status":    result = await handleStatus(args, env); break;
          case "taproot_close":     result = await handleClose(args, env); break;
          default:
            return jsonErr(id, -32601, `Unknown tool: ${p.name}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Internal error";
        // Temporary diagnostic logging (v0.3 taproot_status investigation) —
        // wrangler tail's default view only shows invocation outcome, not
        // the caught error, so log it explicitly to see what's actually
        // failing. Safe to remove once the root cause is confirmed.
        console.error(`[taproot] ${p.name} threw:`, e instanceof Error ? (e.stack ?? e.message) : e);
        return jsonErr(id, -32603, msg);
      }

      return jsonOk(id, { content: [{ type: "text", text: result }] });
    }

    default:
      return jsonErr(id, -32601, `Method not found: ${body.method}`);
  }
}

// ─── Backup Handler ─────────────────────────────────────────────────────────

async function handleBackup(env: Env): Promise<Response> {
  const entries: Array<{
    key: string;
    value: unknown;
    metadata: unknown;
    error?: string;
  }> = [];

  let cursor: string | undefined;
  do {
    const listed = await env.TAPROOT_KV.list({ limit: 1000, cursor });
    for (const { name } of listed.keys) {
      try {
        const { value, metadata } = await env.TAPROOT_KV.getWithMetadata(name, "text");
        let parsed: unknown = value;
        if (typeof value === "string") {
          try {
            parsed = JSON.parse(value);
          } catch {
            // keep as raw string
          }
        }
        entries.push({ key: name, value: parsed, metadata: metadata ?? null });
      } catch (err) {
        entries.push({
          key: name,
          value: null,
          metadata: null,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  return new Response(
    JSON.stringify({
      exported_at: new Date().toISOString(),
      total_keys: entries.length,
      entries,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ─── API Handler (authenticated requests) ───────────────────────────────────
// The OAuth provider validates the access token before calling this.

class TaprootApiHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMcp(request, this.env);
    }

    if (url.pathname === "/backup" && request.method === "GET") {
      return handleBackup(this.env);
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
  apiRoute: ["/mcp", "/backup"],
  apiHandler: TaprootApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
