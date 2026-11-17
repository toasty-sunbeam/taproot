// Result views: a small MCP App attached to every Taproot tool, so that when
// a Claude calls taproot_recall (or any other tool) the person sees readable
// memory cards in the chat instead of a raw JSON block.
//
// Each tool gets its own resource, ui://taproot/view/<tool>. They all serve
// the same client with the tool name baked in, so the view never depends on
// the host telling it which tool ran (hostContext.toolInfo is optional).
//
// What the model receives is unchanged: these tools still return their JSON
// as text content and add no structuredContent. The view parses that text.

export const RESULT_VIEW_PREFIX = "ui://taproot/view/";

export function resultViewUri(tool: string): string {
  return RESULT_VIEW_PREFIX + tool;
}

// Client code is plain JS kept free of backticks and "${" so it can sit inside
// this template literal untouched; String.raw keeps its "\n" escapes intact.
const VIEW_SCRIPT = String.raw`
const CATEGORY_LABELS = { identity: "Identity", relationship: "Relationship", active_thread: "Active thread", error: "Error", episodic: "Episodic" };
const CATEGORY_ORDER = ["identity", "relationship", "active_thread", "error", "episodic"];

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const day = (s) => (s ? String(s).slice(0, 10) : "");
const cat = (c) => h("span", { class: "cat cat-" + c, text: CATEGORY_LABELS[c] || c });
const sal = (s) => (s ? h("span", { class: "badge sal-" + s, text: s }) : null);
const idChip = (id) => (id ? h("code", { class: "id", title: id, text: String(id).slice(0, 8) }) : null);
const coreStar = (core) => (core ? h("span", { class: "badge core", title: "Tier 1 core memory", text: "core" }) : null);
const meta = (...bits) => h("span", { class: "meta" }, bits.filter(Boolean).join(" · "));
const chips = (obj, label) =>
  h("div", { class: "chips" },
    Object.entries(obj || {}).map(([k, v]) =>
      h("span", { class: "chip" + (CATEGORY_LABELS[k] ? " cat-" + k : "") }, (label ? label(k) : CATEGORY_LABELS[k] || k) + " ", h("b", {}, String(v)))));

function longText(text, open) {
  if (!text) return null;
  const s = String(text);
  if (s.length <= 280) return h("div", { class: "text" }, s);
  return h("details", { class: "more", open: open },
    h("summary", {}, h("span", { class: "text preview" }, s.slice(0, 220).trimEnd() + "…")),
    h("div", { class: "text" }, s));
}

function memoryCard(m) {
  const gist = m.gist && m.gist !== m.content ? m.gist : null;
  return h("div", { class: "card bar-" + m.category },
    h("div", { class: "row" }, cat(m.category), sal(m.salience), coreStar(m.core), idChip(m.id),
      m.archived ? h("span", { class: "badge", text: "archived" }) : null,
      h("span", { class: "spacer" }),
      meta(
        m.activation_score !== undefined ? "activation " + m.activation_score : "",
        m.retrieval_count !== undefined ? m.retrieval_count + " recalls" : "",
        day(m.updated_at))),
    gist ? h("div", { class: "gist" }, gist) : null,
    longText(m.content),
    m.tags && m.tags.length ? h("div", { class: "tags" }, m.tags.filter((t) => !String(t).startsWith("_")).map((t) => h("span", { class: "tag", text: t }))) : null);
}

function section(title, count, body, open) {
  return h("details", { class: "section", open: open },
    h("summary", {}, h("span", { class: "section-title", text: title }), count !== undefined ? h("span", { class: "count", text: String(count) }) : null),
    h("div", { class: "section-body" }, body));
}

function byCategory(obj, render, openFirst) {
  return CATEGORY_ORDER.concat(Object.keys(obj || {}).filter((k) => !CATEGORY_ORDER.includes(k)))
    .filter((k) => obj && obj[k] && obj[k].length)
    .map((k, i) => section(CATEGORY_LABELS[k] || k, obj[k].length, obj[k].map(render), openFirst && i === 0));
}

// "[id] [category] [salience] [date] gist" — the reflect catalog line format.
const CATALOG_LINE = /^\[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] \[([^\]]+)\] ([\s\S]*)$/;
function catalogRow(line) {
  const m = CATALOG_LINE.exec(line);
  if (!m) return h("div", { class: "line" }, line);
  return h("div", { class: "line" }, idChip(m[1]), sal(m[3]), h("span", { class: "line-text" }, m[5]), h("span", { class: "meta" }, m[4]));
}

function closingBlock(c) {
  return h("details", { class: "closing" },
    h("summary", {}, h("b", {}, c.conversation_title || "Untitled"), " ", h("span", { class: "meta" }, day(c.created_at))),
    h("div", { class: "text" }, c.reflection || ""));
}

function header(title, ...rest) {
  return h("div", { class: "head" }, h("span", { class: "title" }, title), ...rest);
}

function describeRecall(inp) {
  const bits = [];
  if (inp.query) bits.push("“" + inp.query + "”");
  if (inp.ids && inp.ids.length) bits.push(inp.ids.length + " id" + (inp.ids.length === 1 ? "" : "s"));
  if (inp.category) bits.push(CATEGORY_LABELS[inp.category] || inp.category);
  if (inp.tags && inp.tags.length) bits.push("tags: " + inp.tags.join(", "));
  if (inp.since) bits.push("since " + day(inp.since));
  return bits.join(" · ");
}

const VIEWS = {
  taproot_reflect(r) {
    const core = CATEGORY_ORDER.flatMap((c) => (r.core_memories && r.core_memories[c]) || []);
    const omitted = Object.fromEntries(Object.entries(r.catalog_omitted || {}).filter(([, n]) => n > 0));
    return [
      header("Reflect", meta(core.length + " core", (r.catalog_count ?? "?") + " in catalog")),
      section("Core memories", core.length, core.map(memoryCard), true),
      section("Catalog", r.catalog_count, byCategory(r.catalog, catalogRow, false), false),
      Object.keys(omitted).length ? h("div", { class: "note", title: r.catalog_note || null }, "Not in catalog: ", chips(omitted)) : null,
      r.recent_closings && r.recent_closings.length ? section("Recent closings", r.recent_closings.length, r.recent_closings.map(closingBlock), false) : null,
    ];
  },
  taproot_recall(r, inp) {
    return [
      header("Recall", meta(describeRecall(inp), r.count + " result" + (r.count === 1 ? "" : "s"), r.strengthened ? "strengthened" : "read-only")),
      (r.results || []).map(memoryCard),
    ];
  },
  taproot_remember(r, inp) {
    return [
      header(r.action === "updated" ? "Updated memory" : "Saved memory", cat(r.category), coreStar(r.core), idChip(r.memory_id), inp.gist ? meta(inp.gist) : null),
      h("div", { class: "card bar-" + r.category },
        h("div", { class: "row" }, sal(inp.salience), inp.epistemic_status ? h("span", { class: "badge", text: inp.epistemic_status }) : null),
        inp.gist ? h("div", { class: "gist" }, inp.gist) : null,
        longText(inp.content),
        !inp.gist && !inp.content ? h("div", { class: "meta" }, "Fields changed: " + Object.keys(inp).filter((k) => k !== "update_id").join(", ")) : null,
        inp.tags && inp.tags.length ? h("div", { class: "tags" }, inp.tags.map((t) => h("span", { class: "tag", text: t }))) : null),
      (r.warnings || []).map((w) => h("div", { class: "warn" }, String(w))),
    ];
  },
  taproot_list(r) {
    return [
      header("List", meta(r.filter && r.filter.category !== "all" ? CATEGORY_LABELS[r.filter.category] || r.filter.category : "all categories",
        r.count + " of " + r.total, r.filter && r.filter.include_archived ? "incl. archived" : "")),
      chips(r.total_by_category),
      h("div", { class: "lines" }, (r.items || []).map((m) =>
        h("div", { class: "line" }, h("span", { class: "dot bg-" + m.category, title: CATEGORY_LABELS[m.category] || m.category }), sal(m.salience), coreStar(m.core),
          h("span", { class: "line-text" }, m.gist || ""), m.archived ? h("span", { class: "badge", text: "archived" }) : null,
          h("span", { class: "meta" }, day(m.updated_at))))),
      r.has_more ? h("div", { class: "note" }, "More available (next page cursor returned).") : null,
    ];
  },
  taproot_status(r) {
    const t = r.tiers || {};
    return [
      header("Status", meta(r.status, r.storage)),
      h("div", { class: "stats" },
        stat("Live", r.total_memories), stat("Archived", r.total_archived), stat("Closings", r.closings_count),
        stat("Core", t.core_count), stat("Catalog", t.catalog_count), stat("Reflect ≈ tokens", t.approx_reflect_payload_tokens)),
      h("div", { class: "note" }, "Live by category"), chips(r.memory_counts),
      r.archived_counts ? [h("div", { class: "note" }, "Archived by category"), chips(r.archived_counts)] : null,
    ];
  },
  taproot_forget(r, inp) {
    return [header(r.action === "deleted" ? "Deleted memory" : "Archived memory", idChip(r.memory_id), inp.reason ? meta(inp.reason) : null),
      inp.reason ? h("div", { class: "text" }, inp.reason) : null, r.note ? h("div", { class: "meta" }, r.note) : null];
  },
  taproot_promote(r) {
    return [header("Promoted memory", idChip(r.memory_id)), h("div", { class: "row" }, sal(r.salience), r.core ? coreStar(true) : h("span", { class: "badge", text: "not core" }))];
  },
  taproot_close(r, inp) {
    return [header("Closing", meta(inp.conversation_title || "stored")),
      h("div", { class: "text" }, inp.reflection || "")];
  },
};

function stat(label, value) {
  return value === undefined || value === null ? null : h("div", { class: "stat" }, h("b", {}, String(value)), h("span", {}, label));
}

function jsonTree(value, depth) {
  if (value === null || typeof value !== "object") return h("span", { class: "j-" + (value === null ? "null" : typeof value) }, JSON.stringify(value));
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (!entries.length) return h("span", {}, Array.isArray(value) ? "[]" : "{}");
  return h("details", { class: "j", open: depth < 2 },
    h("summary", {}, Array.isArray(value) ? "[" + entries.length + "]" : "{" + entries.length + "}"),
    entries.map(([k, v]) => h("div", { class: "j-row" }, h("span", { class: "j-key" }, String(k) + ": "), jsonTree(v, depth + 1))));
}

let input = {};
let raw = null;
function render() {
  const root = document.getElementById("root");
  if (!raw) {
    root.replaceChildren(h("div", { class: "meta pending" }, "Running " + TOOL.replace("taproot_", "") + "…"));
    return;
  }
  const text = raw.content && raw.content[0] && raw.content[0].text;
  let data = raw.structuredContent;
  if (data === undefined) { try { data = JSON.parse(text); } catch { data = undefined; } }

  let view;
  if (raw.isError || data === undefined) view = h("div", { class: "error" }, text || "Tool error");
  else if (data.status === "error") view = h("div", { class: "error" }, data.message || "Error");
  else if (VIEWS[TOOL]) {
    try { view = VIEWS[TOOL](data, input || {}); }
    catch (e) { console.error(e); view = null; }
  }
  if (!view) view = [header(TOOL.replace("taproot_", "")), jsonTree(data, 0)];

  // Collapsed by default: the view's own header line becomes the summary
  // beside a disclosure triangle, and everything else waits inside.
  const parts = [view].flat(Infinity).filter(Boolean);
  const failed = parts.length === 1 && parts[0].classList.contains("error");
  const head = failed
    ? header(TOOL.replace("taproot_", ""), h("span", { class: "meta err" }, "failed"))
    : parts[0].classList.contains("head") ? parts.shift() : header(TOOL.replace("taproot_", ""));

  const toggle = h("button", { class: "raw-toggle", onclick: () => {
    const showing = root.classList.toggle("show-raw");
    toggle.textContent = showing ? "Formatted" : "JSON";
  } }, "JSON");
  root.replaceChildren(h("details", { class: "block" },
    h("summary", {}, head),
    h("div", { class: "body" },
      h("div", { class: "tools" }, toggle),
      h("div", { class: "formatted" }, parts),
      h("pre", { class: "raw" }, text || JSON.stringify(data, null, 2)))));
}

function applyTheme(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles && ctx.styles.css && ctx.styles.css.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.ontoolinput = (p) => { input = (p && p.arguments) || {}; render(); };
app.ontoolresult = (result) => { raw = result; render(); };
app.ontoolcancelled = () => { document.getElementById("root").replaceChildren(h("div", { class: "meta" }, "Cancelled.")); };
app.onhostcontextchanged = applyTheme;
render();
await app.connect();
applyTheme(app.getHostContext());
`;

// Host style variables (Claude supplies them) with system-colour fallbacks so
// the view still reads well in a host that sends none.
const VIEW_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 4px 2px 8px;
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--font-text-sm-size, 13.5px); line-height: 1.45;
    color: var(--color-text-primary, CanvasText); background: transparent;
    --line: var(--color-border-tertiary, color-mix(in srgb, currentColor 14%, transparent));
    --soft: var(--color-background-secondary, color-mix(in srgb, currentColor 5%, transparent));
    --dim: var(--color-text-secondary, color-mix(in srgb, currentColor 62%, transparent));
    --c-identity: #818cf8; --c-relationship: #ec4899; --c-active_thread: #14b8a6; --c-error: #ef4444; --c-episodic: #f59e0b;
  }
  .head { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
  .head > * { flex: none; }
  .head > .meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta.err { color: var(--color-text-danger, #dc2626); }
  details.block > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 2px 0; user-select: none; }
  details.block > summary::-webkit-details-marker { display: none; }
  details.block > summary::before { content: "▸"; color: var(--dim); display: inline-block; width: 10px; flex: none; }
  details.block[open] > summary::before { transform: rotate(90deg); }
  details.block[open] > summary .head > .meta { white-space: normal; }
  .body { margin: 6px 0 0 16px; }
  .tools { display: flex; justify-content: flex-end; margin-bottom: 2px; }
  .title { font-weight: var(--font-weight-semibold, 600); }
  .meta { color: var(--dim); font-size: 12px; }
  .pending { padding: 6px 0; }
  .spacer { flex: 1; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .card { border: 1px solid var(--line); border-left: 3px solid var(--line); border-radius: var(--border-radius-md, 8px); padding: 8px 10px; margin: 6px 0; background: var(--soft); }
  .gist { font-weight: var(--font-weight-medium, 500); margin-top: 5px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 5px; }
  .preview { display: inline; color: var(--dim); }
  details.more > summary { list-style: none; cursor: pointer; }
  details.more > summary::-webkit-details-marker { display: none; }
  details.more[open] > summary { display: none; }
  .cat { font-size: 11.5px; font-weight: 600; }
  .badge, .tag, .chip { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; white-space: nowrap; }
  .badge.core { border-color: var(--c-identity); color: var(--c-identity); }
  .sal-high { font-weight: 600; } .sal-low { color: var(--dim); }
  .tags, .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .chip { padding: 1px 8px; }
  code.id { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--dim); }
  .section { margin: 4px 0; }
  .section > summary { cursor: pointer; padding: 4px 0; font-weight: 600; }
  .section-body { padding-left: 4px; }
  .count { color: var(--dim); font-weight: normal; margin-left: 6px; font-size: 12px; }
  .lines { margin-top: 6px; }
  .line { display: flex; align-items: baseline; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--line); }
  .line:last-child { border-bottom: 0; }
  .line-text { flex: 1; min-width: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; background: var(--line); }
  .closing > summary { cursor: pointer; padding: 3px 0; }
  .note { color: var(--dim); font-size: 12px; margin-top: 8px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
  .stat { border: 1px solid var(--line); border-radius: var(--border-radius-md, 8px); padding: 6px 8px; background: var(--soft); display: flex; flex-direction: column; }
  .stat b { font-size: 16px; } .stat span { color: var(--dim); font-size: 11.5px; }
  .warn { color: var(--color-text-warning, #b45309); margin-top: 6px; }
  .error { color: var(--color-text-danger, #dc2626); border: 1px solid currentColor; border-radius: var(--border-radius-md, 8px); padding: 8px 10px; white-space: pre-wrap; }
  .raw { display: none; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; margin: 0; max-height: 480px; overflow: auto; }
  .show-raw .raw { display: block; } .show-raw .formatted { display: none; }
  .raw-toggle { font: inherit; font-size: 11px; color: var(--dim); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; cursor: pointer; }
  .j { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; } .j > summary { cursor: pointer; color: var(--dim); }
  .j-row { padding-left: 14px; } .j-key { color: var(--dim); } .j-string { color: #16a34a; } .j-number { color: #2563eb; }
  CATEGORY_RULES
`;

const CATEGORIES = ["identity", "relationship", "active_thread", "error", "episodic"];
const CATEGORY_RULES = CATEGORIES.map(
  (c) => `.cat-${c} { color: var(--c-${c}); } .chip.cat-${c} { border-color: var(--c-${c}); } .bar-${c} { border-left-color: var(--c-${c}); } .bg-${c} { background: var(--c-${c}); }`,
).join("\n  ");

export function renderResultViewHtml(tool: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Taproot · ${tool}</title>
<style>${VIEW_STYLE.replace("CATEGORY_RULES", CATEGORY_RULES)}</style>
</head>
<body>
<div id="root"></div>
<script type="module">
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from "https://unpkg.com/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js";
const TOOL = ${JSON.stringify(tool)};
const app = new App({ name: "Taproot view", version: "1.0.0" });
${VIEW_SCRIPT}
</script>
</body>
</html>`;
}
