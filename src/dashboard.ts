// Taproot Memory Dashboard — password-gated browser UI for browsing memories
// and curating salience/core (Tier 1) membership.
//
// Distinct from the OAuth-protected /mcp route: MCP clients authenticate with
// a bearer token from the DCR flow, but a human clicking around in a browser
// just wants a password prompt. This module owns its own lightweight
// cookie session (backed by TAPROOT_KV) rather than reusing the OAuth flow.

import type { Memory, MemorySalience } from "./types.js";
import type { Env } from "./storage.js";
import {
  listMemoryKeys,
  idFromKey,
  getMemory,
  putMemory,
  metaHasTag,
  REFLECT_CONFIG,
  inCatalogWindow,
  buildReflectPayload,
} from "./storage.js";

const SESSION_COOKIE = "taproot_dash";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ─── Session helpers ──────────────────────────────────────────────────────────

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// `wrangler dev` serves over plain http:// locally; a `Secure` cookie
// wouldn't survive a login round-trip there. Only set it when the request
// actually arrived over https.
function cookieAttrs(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `Path=/dashboard; HttpOnly;${secure} SameSite=Lax`;
}

function setCookieHeader(request: Request, token: string): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs(request)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearCookieHeader(request: Request): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(request)}; Max-Age=0`;
}

async function isAuthed(request: Request, env: Env): Promise<boolean> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  return (await env.TAPROOT_KV.get(`dashsession:${token}`)) !== null;
}

async function requireAuth(
  request: Request,
  env: Env,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (!(await isAuthed(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  return handler();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Login ────────────────────────────────────────────────────────────────────

function renderDashboardLogin(errorMsg?: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Taproot — Memory Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 420px; margin: 90px auto; padding: 20px; background: #0f1115; color: #e5e7eb; }
  h1 { font-weight: 600; margin-bottom: 4px; }
  p { color: #9ca3af; line-height: 1.5; }
  form { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; }
  input[type="password"] { padding: 10px 12px; font-size: 16px; border: 1px solid #2a2e37; border-radius: 6px; font-family: inherit; background: #1a1d24; color: #e5e7eb; }
  button { padding: 10px 12px; font-size: 15px; border: none; background: #6366f1; color: white; border-radius: 6px; cursor: pointer; font-family: inherit; font-weight: 600; }
  button:hover { background: #4f46e5; }
  .error { color: #f87171; margin-top: 4px; font-size: 14px; }
</style>
</head>
<body>
  <h1>Taproot</h1>
  <p>Memory dashboard — enter the auth token to continue.</p>
  <form method="POST" action="/dashboard/login">
    <input type="password" name="password" placeholder="Auth token" required autofocus />
    <button type="submit">Enter</button>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ""}
  </form>
</body>
</html>`;
  return new Response(html, {
    status: errorMsg ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const password = formData.get("password");
  if (typeof password !== "string" || password !== env.TAPROOT_AUTH_TOKEN) {
    return renderDashboardLogin("Incorrect auth token.");
  }
  const token = crypto.randomUUID();
  await env.TAPROOT_KV.put(`dashsession:${token}`, "1", { expirationTtl: SESSION_TTL_SECONDS });
  const headers = new Headers({ Location: "/dashboard" });
  headers.append("Set-Cookie", setCookieHeader(request, token));
  return new Response(null, { status: 302, headers });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.TAPROOT_KV.delete(`dashsession:${token}`);
  const headers = new Headers({ Location: "/dashboard" });
  headers.append("Set-Cookie", clearCookieHeader(request));
  return new Response(null, { status: 302, headers });
}

// ─── Memory listing (dashboard wire format) ──────────────────────────────────

type ReflectTier = "core" | "catalog" | "omitted" | "archived";

interface DashboardMemory {
  id: string;
  category: string;
  salience: MemorySalience;
  gist: string;
  content: string;
  tags: string[];
  core: boolean;
  tier: ReflectTier;
  created_at: string;
  updated_at: string;
  last_retrieved: string | null;
  retrieval_count: number;
  epistemic_status: string;
}

function classifyTier(m: Memory, cutoffMs: number): ReflectTier {
  if (metaHasTag(m.tags, "_archive_pending")) return "archived";
  if (m.core) return "core";
  return inCatalogWindow(m.salience, m.updated_at, m.last_retrieved, cutoffMs) ? "catalog" : "omitted";
}

function toDashboardMemory(m: Memory, cutoffMs: number): DashboardMemory {
  return {
    id: m.id,
    category: m.category,
    salience: m.salience,
    gist: m.gist,
    content: m.content,
    tags: m.tags,
    core: m.core,
    tier: classifyTier(m, cutoffMs),
    created_at: m.created_at,
    updated_at: m.updated_at,
    last_retrieved: m.last_retrieved,
    retrieval_count: m.retrieval_count,
    epistemic_status: m.epistemic_status,
  };
}

async function handleListMemories(env: Env): Promise<Response> {
  const cutoffMs = Date.now() - REFLECT_CONFIG.CATALOG_WINDOW_DAYS * 86_400_000;
  const allKeys = await listMemoryKeys(env.TAPROOT_KV);
  const memories = (
    await Promise.all(allKeys.map(k => getMemory(env.TAPROOT_KV, idFromKey(k.name))))
  ).filter((m): m is Memory => m !== null);

  return json({
    memories: memories
      .map(m => toDashboardMemory(m, cutoffMs))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    catalog_window_days: REFLECT_CONFIG.CATALOG_WINDOW_DAYS,
  });
}

async function handleUpdateMemory(id: string, request: Request, env: Env): Promise<Response> {
  let body: { salience?: unknown; core?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (body.salience !== undefined && !["high", "medium", "low"].includes(body.salience as string)) {
    return json({ error: `Invalid salience "${String(body.salience)}"` }, 400);
  }
  if (body.core !== undefined && typeof body.core !== "boolean") {
    return json({ error: "core must be a boolean" }, 400);
  }
  if (body.salience === undefined && body.core === undefined) {
    return json({ error: "Provide salience and/or core to change" }, 400);
  }

  const existing = await getMemory(env.TAPROOT_KV, id);
  if (!existing) return json({ error: `Memory ${id} not found` }, 404);

  // Deliberately does NOT bump updated_at, unlike taproot_promote. This
  // endpoint exists to trim the reflect payload — if editing salience
  // refreshed the memory's "last touched" date, downgrading a stale
  // high-salience memory would paradoxically keep it in the catalog window
  // for another CATALOG_WINDOW_DAYS instead of letting it roll off.
  const updated: Memory = {
    ...existing,
    salience: (body.salience as MemorySalience) ?? existing.salience,
    core: (body.core as boolean | undefined) ?? existing.core,
  };
  await putMemory(env.TAPROOT_KV, updated);

  const cutoffMs = Date.now() - REFLECT_CONFIG.CATALOG_WINDOW_DAYS * 86_400_000;
  return json({ memory: toDashboardMemory(updated, cutoffMs) });
}

async function handleReflectPreview(env: Env): Promise<Response> {
  const payload = await buildReflectPayload(env);
  const bytes = JSON.stringify(payload).length;
  return json({
    payload,
    approx_bytes: bytes,
    approx_kb: Math.round((bytes / 1024) * 10) / 10,
    approx_tokens: Math.ceil(bytes / 4),
    catalog_window_days: REFLECT_CONFIG.CATALOG_WINDOW_DAYS,
  });
}

// ─── Dashboard shell (client app) ─────────────────────────────────────────────

function renderDashboardShell(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Taproot — Memory Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌱</text></svg>" />
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1d212a;
    --border: #2a2e37;
    --text: #e5e7eb;
    --text-dim: #9ca3af;
    --text-faint: #6b7280;
    --accent: #6366f1;
    --cat-identity: #818cf8;
    --cat-relationship: #f472b6;
    --cat-active_thread: #2dd4bf;
    --cat-error: #f87171;
    --cat-episodic: #fbbf24;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  header { position: sticky; top: 0; z-index: 10; background: var(--panel); border-bottom: 1px solid var(--border); padding: 14px 20px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { font-size: 17px; font-weight: 600; margin: 0; white-space: nowrap; }
  .stats { display: flex; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-dim); }
  .stat { background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; white-space: nowrap; }
  .stat b { color: var(--text); }
  .stat.warn { border-color: #b45309; color: #fbbf24; }
  .stat.warn b { color: #fbbf24; }
  header .spacer { flex: 1; }
  header button, .sidebar-close { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: inherit; font-weight: 500; }
  header button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  header button:hover { filter: brightness(1.15); }
  form.logout { margin: 0; }

  .legend { display: flex; gap: 14px; flex-wrap: wrap; padding: 10px 20px; font-size: 12px; color: var(--text-dim); border-bottom: 1px solid var(--border); background: var(--panel); }
  .legend .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }

  .toolbar { display: flex; gap: 8px; align-items: center; padding: 12px 20px; flex-wrap: wrap; border-bottom: 1px solid var(--border); }
  .toolbar input[type="search"] { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 7px 10px; border-radius: 6px; font-size: 13px; min-width: 200px; font-family: inherit; }
  .chip-group { display: flex; gap: 4px; flex-wrap: wrap; }
  .chip { background: var(--panel-2); border: 1px solid var(--border); color: var(--text-dim); padding: 5px 10px; border-radius: 999px; font-size: 12px; cursor: pointer; user-select: none; }
  .chip.active { color: white; border-color: transparent; }
  .toolbar select { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 6px 8px; border-radius: 6px; font-size: 12.5px; font-family: inherit; }
  .shown-count { font-size: 12px; color: var(--text-faint); margin-left: auto; }

  main { display: flex; }
  #list { flex: 1; padding: 16px 20px 60px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }

  .card { background: var(--panel); border: 1px solid var(--border); border-left-width: 4px; border-radius: 8px; padding: 12px 14px; transition: box-shadow .2s, background .3s; }
  .card.flash { box-shadow: 0 0 0 2px var(--accent); background: var(--panel-2); }
  .card-top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .gist { font-weight: 600; font-size: 13.5px; cursor: pointer; }
  .badge { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; }
  .badge.cat { color: #0f1115; }
  .badge.tier-core { background: #4338ca; color: white; }
  .badge.tier-catalog { background: transparent; border: 1px solid var(--text-faint); color: var(--text-dim); }
  .badge.tier-omitted { background: transparent; border: 1px dashed var(--text-faint); color: var(--text-faint); }
  .badge.tier-archived { background: transparent; border: 1px solid #7f1d1d; color: #b91c1c; text-decoration: line-through; }
  .card-id { font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--text-faint); margin-left: auto; }

  .card-controls { display: flex; align-items: center; gap: 14px; margin-top: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
  .card-controls label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .card-controls select { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); padding: 4px 6px; border-radius: 5px; font-size: 12px; font-family: inherit; }
  .card-controls select[data-salience="high"] { color: #fca5a5; }
  .card-controls select[data-salience="medium"] { color: #fcd34d; }
  .card-controls select[data-salience="low"] { color: var(--text-faint); }

  .content { display: none; margin-top: 10px; font-size: 13px; line-height: 1.55; color: var(--text-dim); white-space: pre-wrap; border-top: 1px solid var(--border); padding-top: 10px; }
  .content.open { display: block; }

  #sidebar { width: 0; overflow: hidden; border-left: 1px solid var(--border); background: var(--panel); transition: width .2s; }
  body.sidebar-open #sidebar { width: 420px; flex-shrink: 0; }
  #sidebar-inner { width: 420px; padding: 16px 18px 60px; }
  #sidebar h2 { font-size: 14px; margin: 0 0 4px; }
  .payload-size { font-size: 26px; font-weight: 700; margin: 6px 0 2px; }
  .payload-note { font-size: 11.5px; color: var(--text-faint); margin-bottom: 14px; }
  .sb-section { margin-top: 18px; }
  .sb-section > h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-faint); margin: 0 0 8px; }
  .sb-cat-group { margin-bottom: 10px; }
  .sb-cat-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; margin-bottom: 4px; }
  .sb-block { border-left: 3px solid; border-radius: 4px; background: var(--panel-2); padding: 6px 8px; font-size: 11.5px; margin-bottom: 4px; cursor: pointer; line-height: 1.4; }
  .sb-block:hover { filter: brightness(1.2); }
  .sb-block.core-block { font-size: 12px; max-height: 90px; overflow: auto; white-space: pre-wrap; }
  .sb-omitted-chip { display: inline-block; font-size: 11px; color: var(--text-faint); background: var(--panel-2); border: 1px dashed var(--border); border-radius: 999px; padding: 3px 9px; margin: 2px 4px 2px 0; }
  .sb-empty { font-size: 11.5px; color: var(--text-faint); font-style: italic; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--panel-2); border: 1px solid var(--border); padding: 8px 16px; border-radius: 6px; font-size: 12.5px; color: var(--text-dim); opacity: 0; pointer-events: none; transition: opacity .2s; }
  .toast.show { opacity: 1; }

  @media (max-width: 860px) {
    body.sidebar-open #sidebar { width: 100%; position: fixed; inset: 0; z-index: 20; overflow-y: auto; }
    body.sidebar-open #sidebar-inner { width: 100%; }
  }
</style>
</head>
<body>
  <header>
    <h1>Taproot Memories</h1>
    <div class="stats" id="stats"></div>
    <div class="spacer"></div>
    <button class="primary" id="toggle-sidebar">Reflect Preview</button>
    <form class="logout" method="POST" action="/dashboard/logout"><button type="submit">Log out</button></form>
  </header>

  <div class="legend" id="legend"></div>

  <div class="toolbar">
    <input type="search" id="search" placeholder="Search gist, content, tags…" />
    <div class="chip-group" id="cat-filters"></div>
    <select id="tier-filter">
      <option value="all">All tiers</option>
      <option value="core">Core</option>
      <option value="catalog">Catalog</option>
      <option value="omitted">Omitted</option>
      <option value="archived">Archived</option>
    </select>
    <select id="salience-filter">
      <option value="all">All salience</option>
      <option value="high">High</option>
      <option value="medium">Medium</option>
      <option value="low">Low</option>
    </select>
    <select id="sort">
      <option value="updated_desc">Sort: recently updated</option>
      <option value="updated_asc">Sort: oldest updated</option>
      <option value="salience">Sort: salience (high first)</option>
      <option value="retrieval">Sort: retrieval count</option>
      <option value="category">Sort: category</option>
    </select>
    <span class="shown-count" id="shown-count"></span>
  </div>

  <main>
    <div id="list"></div>
    <div id="sidebar"><div id="sidebar-inner"></div></div>
  </main>

  <div class="toast" id="toast"></div>

<script>
const CATEGORIES = ["identity", "relationship", "active_thread", "error", "episodic"];
const CATEGORY_LABELS = { identity: "Identity", relationship: "Relationship", active_thread: "Active Thread", error: "Error", episodic: "Episodic" };
const CATEGORY_COLORS = {
  identity: "#818cf8", relationship: "#f472b6", active_thread: "#2dd4bf", error: "#f87171", episodic: "#fbbf24",
};
const TIER_LABELS = { core: "Core", catalog: "Catalog", omitted: "Omitted", archived: "Archived" };

let memories = [];
let reflectData = null;
let sidebarOpen = false;
const filters = { search: "", categories: new Set(), tier: "all", salience: "all" };
let sort = "updated_desc";

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
}

async function api(path, opts) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { location.href = "/dashboard"; throw new Error("unauthorized"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function buildLegend() {
  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  for (const cat of CATEGORIES) {
    legend.appendChild(el("span", {}, el("span", { class: "dot", style: "background:" + CATEGORY_COLORS[cat] }), CATEGORY_LABELS[cat]));
  }
  legend.appendChild(el("span", { style: "color:var(--text-faint)" }, "Colors match the Reflect Preview →"));
}

function buildCatFilterChips() {
  const wrap = document.getElementById("cat-filters");
  wrap.innerHTML = "";
  for (const cat of CATEGORIES) {
    const chip = el("span", {
      class: "chip",
      style: "border-color:" + CATEGORY_COLORS[cat],
      onclick: () => {
        if (filters.categories.has(cat)) filters.categories.delete(cat); else filters.categories.add(cat);
        chip.classList.toggle("active");
        chip.style.background = filters.categories.has(cat) ? CATEGORY_COLORS[cat] : "";
        chip.style.color = filters.categories.has(cat) ? "#0f1115" : "";
        renderList();
      },
    }, CATEGORY_LABELS[cat]);
    wrap.appendChild(chip);
  }
}

function tierCounts() {
  const counts = { core: 0, catalog: 0, omitted: 0, archived: 0 };
  for (const m of memories) counts[m.tier]++;
  return counts;
}

function renderStats() {
  const counts = tierCounts();
  const stats = document.getElementById("stats");
  stats.innerHTML = "";
  stats.appendChild(el("span", { class: "stat" }, el("b", { text: String(counts.core) }), " core"));
  stats.appendChild(el("span", { class: "stat" }, el("b", { text: String(counts.catalog) }), " catalog"));
  stats.appendChild(el("span", { class: "stat" }, el("b", { text: String(counts.omitted) }), " omitted"));
  if (counts.archived > 0) stats.appendChild(el("span", { class: "stat" }, el("b", { text: String(counts.archived) }), " archived"));
  if (reflectData) {
    const big = reflectData.approx_kb > 30;
    stats.appendChild(el("span", { class: "stat" + (big ? " warn" : "") }, el("b", { text: reflectData.approx_kb + " KB" }), " / ~" + reflectData.approx_tokens + " tok reflect payload"));
  }
}

function matchesFilters(m) {
  if (filters.categories.size > 0 && !filters.categories.has(m.category)) return false;
  if (filters.tier !== "all" && m.tier !== filters.tier) return false;
  if (filters.salience !== "all" && m.salience !== filters.salience) return false;
  if (filters.search) {
    const hay = (m.gist + " " + m.content + " " + m.tags.join(" ")).toLowerCase();
    if (!hay.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}

const SALIENCE_RANK = { high: 0, medium: 1, low: 2 };

function sortedFiltered() {
  const out = memories.filter(matchesFilters);
  switch (sort) {
    case "updated_asc": out.sort((a, b) => a.updated_at.localeCompare(b.updated_at)); break;
    case "salience": out.sort((a, b) => SALIENCE_RANK[a.salience] - SALIENCE_RANK[b.salience]); break;
    case "retrieval": out.sort((a, b) => b.retrieval_count - a.retrieval_count); break;
    case "category": out.sort((a, b) => a.category.localeCompare(b.category) || b.updated_at.localeCompare(a.updated_at)); break;
    default: out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  return out;
}

function fmtDate(s) { return s ? s.slice(0, 10) : "—"; }

function buildCard(m) {
  const card = el("div", { class: "card", "data-card-id": m.id, style: "border-left-color:" + CATEGORY_COLORS[m.category] });

  const gist = el("span", { class: "gist", text: m.gist, onclick: () => content.classList.toggle("open") });
  const catBadge = el("span", { class: "badge cat", style: "background:" + CATEGORY_COLORS[m.category], text: CATEGORY_LABELS[m.category] });
  const tierBadge = el("span", { class: "badge tier-" + m.tier, text: TIER_LABELS[m.tier] });
  const idSpan = el("span", { class: "card-id", text: m.id.slice(0, 8) });

  const top = el("div", { class: "card-top" }, gist, catBadge, tierBadge, idSpan);

  const salSelect = el("select", { "data-salience": m.salience, onchange: (e) => patch(m.id, { salience: e.target.value }) });
  for (const s of ["high", "medium", "low"]) {
    salSelect.appendChild(el("option", { value: s, selected: s === m.salience ? "" : undefined, text: s.charAt(0).toUpperCase() + s.slice(1) }));
  }

  const coreCheck = el("input", { type: "checkbox", checked: m.core ? "" : undefined, onchange: (e) => patch(m.id, { core: e.target.checked }) });
  const coreLabel = el("label", {}, coreCheck, "Tier 1 (core)");

  const controls = el("div", { class: "card-controls" },
    el("label", {}, "Salience", salSelect),
    coreLabel,
    el("span", {}, "Updated " + fmtDate(m.updated_at)),
    el("span", {}, m.retrieval_count + " recalls"),
    m.tags.length ? el("span", { text: m.tags.join(", ") }) : null,
  );

  const content = el("div", { class: "content", text: m.content });

  card.append(top, controls, content);
  return card;
}

function renderList() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  const shown = sortedFiltered();
  for (const m of shown) list.appendChild(buildCard(m));
  document.getElementById("shown-count").textContent = shown.length + " of " + memories.length + " shown";
}

function updateCardInPlace(m) {
  const idx = memories.findIndex(x => x.id === m.id);
  if (idx !== -1) memories[idx] = m;
  renderList();
  renderStats();
}

async function patch(id, changes) {
  try {
    const { memory } = await api("/dashboard/api/memories/" + id, { method: "PATCH", body: JSON.stringify(changes) });
    updateCardInPlace(memory);
    if (sidebarOpen) loadReflect();
    toast("Saved");
  } catch (e) {
    toast("Failed to save: " + e.message);
  }
}

function catGroupBlocks(byCategory, renderBlock) {
  const wrap = document.createDocumentFragment();
  let any = false;
  for (const cat of CATEGORIES) {
    const items = byCategory[cat] || [];
    if (items.length === 0) continue;
    any = true;
    const group = el("div", { class: "sb-cat-group" },
      el("div", { class: "sb-cat-label", style: "color:" + CATEGORY_COLORS[cat] }, CATEGORY_LABELS[cat]),
    );
    for (const item of items) group.appendChild(renderBlock(item, cat));
    wrap.appendChild(group);
  }
  if (!any) wrap.appendChild(el("div", { class: "sb-empty", text: "Nothing here right now." }));
  return wrap;
}

function scrollToCard(id) {
  const card = document.querySelector('[data-card-id="' + id + '"]');
  if (!card) { toast("That memory is hidden by your current filters."); return; }
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1200);
}

function renderSidebar() {
  const wrap = document.getElementById("sidebar-inner");
  wrap.innerHTML = "";
  if (!reflectData) { wrap.appendChild(el("div", { class: "sb-empty", text: "Loading…" })); return; }
  const { payload, approx_kb, approx_tokens } = reflectData;

  wrap.appendChild(el("h2", { text: "What taproot_reflect returns right now" }));
  wrap.appendChild(el("div", { class: "payload-size", text: approx_kb + " KB" }));
  wrap.appendChild(el("div", { class: "payload-note", text: "~" + approx_tokens + " tokens · " + payload.core_count + " core · " + payload.catalog_count + " catalog lines · window " + reflectData.catalog_window_days + "d" }));

  wrap.appendChild(el("div", { class: "sb-section" },
    el("h3", { text: "Tier 1 — Core (full text)" }),
    catGroupBlocks(payload.core_memories, (m, cat) =>
      el("div", {
        class: "sb-block core-block", style: "border-left-color:" + CATEGORY_COLORS[cat],
        onclick: () => scrollToCard(m.id),
      }, m.content),
    ),
  ));

  wrap.appendChild(el("div", { class: "sb-section" },
    el("h3", { text: "Tier 2 — Catalog (gist lines)" }),
    catGroupBlocks(payload.catalog, (line, cat) => {
      const id = (line.match(/^\\[([^\\]]+)\\]/) || [])[1] || "";
      return el("div", { class: "sb-block", style: "border-left-color:" + CATEGORY_COLORS[cat], onclick: () => scrollToCard(id) }, line);
    }),
  ));

  const omittedEntries = Object.entries(payload.catalog_omitted).filter(([, n]) => n > 0);
  wrap.appendChild(el("div", { class: "sb-section" },
    el("h3", { text: "Omitted (not itemized in the real payload)" }),
    omittedEntries.length
      ? el("div", {}, ...omittedEntries.map(([cat, n]) => el("span", { class: "sb-omitted-chip", style: "border-color:" + (CATEGORY_COLORS[cat] || "#333") }, n + " " + (CATEGORY_LABELS[cat] || cat))))
      : el("div", { class: "sb-empty", text: "Nothing omitted." }),
  ));
}

async function loadMemories() {
  const data = await api("/dashboard/api/memories");
  memories = data.memories;
  renderStats();
  renderList();
}

async function loadReflect() {
  reflectData = await api("/dashboard/api/reflect");
  renderStats();
  renderSidebar();
}

document.getElementById("toggle-sidebar").addEventListener("click", () => {
  sidebarOpen = !sidebarOpen;
  document.body.classList.toggle("sidebar-open", sidebarOpen);
  if (sidebarOpen && !reflectData) loadReflect();
});
document.getElementById("search").addEventListener("input", (e) => { filters.search = e.target.value; renderList(); });
document.getElementById("tier-filter").addEventListener("change", (e) => { filters.tier = e.target.value; renderList(); });
document.getElementById("salience-filter").addEventListener("change", (e) => { filters.salience = e.target.value; renderList(); });
document.getElementById("sort").addEventListener("change", (e) => { sort = e.target.value; renderList(); });

buildLegend();
buildCatFilterChips();
loadMemories().catch(e => toast("Failed to load: " + e.message));
</script>
</body>
</html>`;

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function handleDashboardRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/dashboard")) return null;

  if (url.pathname === "/dashboard" && request.method === "GET") {
    return (await isAuthed(request, env)) ? renderDashboardShell() : renderDashboardLogin();
  }
  if (url.pathname === "/dashboard/login" && request.method === "POST") {
    return handleLogin(request, env);
  }
  if (url.pathname === "/dashboard/logout" && request.method === "POST") {
    return handleLogout(request, env);
  }
  if (url.pathname === "/dashboard/api/memories" && request.method === "GET") {
    return requireAuth(request, env, () => handleListMemories(env));
  }
  if (url.pathname.startsWith("/dashboard/api/memories/") && request.method === "PATCH") {
    const id = url.pathname.slice("/dashboard/api/memories/".length);
    return requireAuth(request, env, () => handleUpdateMemory(id, request, env));
  }
  if (url.pathname === "/dashboard/api/reflect" && request.method === "GET") {
    return requireAuth(request, env, () => handleReflectPreview(env));
  }

  return json({ error: "Not found" }, 404);
}
