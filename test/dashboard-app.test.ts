// MCP App: the dashboard rendered inside Claude (taproot_dashboard + ui:// resource).
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, makeEnv, seed, rawRecord } from "./helpers.ts";
import { renderDashboardHtml } from "../src/dashboard.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(env: any, method: string, params: unknown = {}) {
  const req = new Request("https://taproot.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await __test.handleMcp(req, env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await res.json()) as any;
}

test("initialize advertises resources", async () => {
  const { env } = makeEnv();
  const r = await rpc(env, "initialize");
  assert.deepEqual(r.result.capabilities.resources, {});
});

test("taproot_dashboard points at the UI resource; dash tools are app-only", async () => {
  const { env } = makeEnv();
  const { result } = await rpc(env, "tools/list");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]));

  const open = byName.taproot_dashboard;
  assert.equal(open._meta.ui.resourceUri, "ui://taproot/dashboard");
  assert.equal(open._meta["ui/resourceUri"], "ui://taproot/dashboard");
  assert.equal(open._meta.ui.visibility, undefined, "the opener must stay visible to the model");

  for (const n of ["taproot_dash_memories", "taproot_dash_closings", "taproot_dash_reflect", "taproot_dash_update"]) {
    assert.deepEqual(byName[n]._meta.ui.visibility, ["app"], n);
  }
  assert.ok(byName.taproot_reflect, "existing tools still listed");
});

test("resources/read serves the app HTML with the MCP App mime type", async () => {
  const { env } = makeEnv();
  const listed = await rpc(env, "resources/list");
  assert.equal(listed.result.resources[0].uri, "ui://taproot/dashboard");

  const { result } = await rpc(env, "resources/read", { uri: "ui://taproot/dashboard" });
  const c = result.contents[0];
  assert.equal(c.mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(c._meta.ui.csp.resourceDomains, ["https://unpkg.com"]);
  assert.match(c.text, /callServerTool/);
  assert.doesNotMatch(c.text, /fetch\(path/, "app mode must not use the cookie API");
  assert.doesNotMatch(c.text, /dashboard\/logout/);

  const missing = await rpc(env, "resources/read", { uri: "ui://nope" });
  assert.equal(missing.error.code, -32002);
});

test("web mode is unchanged: cookie fetch, logout, classic script", () => {
  const html = renderDashboardHtml("web");
  assert.match(html, /fetch\(path, \{ credentials: "same-origin"/);
  assert.match(html, /action="\/dashboard\/logout"/);
  assert.doesNotMatch(html, /type="module"/);
  assert.doesNotMatch(html, /callServerTool/);
});

test("the client script in both modes parses as JavaScript", () => {
  for (const mode of ["web", "app"] as const) {
    const html = renderDashboardHtml(mode);
    const open = html.lastIndexOf("<script");
    const script = html.slice(html.indexOf(">", open) + 1, html.lastIndexOf("</script>"));
    // Module syntax (import, top-level await) can't go through new Function;
    // strip the import and wrap in an async function to check the rest parses.
    const body = script.replace(/^import .*$/m, "");
    assert.doesNotThrow(() => new Function(`return (async () => {${body}\n})`), mode);
  }
});

test("taproot_dashboard returns a short summary with status as structuredContent", async () => {
  const { env } = makeEnv();
  await seed(env, { category: "identity" });
  await seed(env, { category: "episodic" });
  const { result } = await rpc(env, "tools/call", { name: "taproot_dashboard", arguments: {} });
  assert.match(result.content[0].text, /^Opened the Taproot dashboard\. 2 live memories/);
  assert.equal(result.structuredContent.total_memories, 2);
});

test("taproot_dash_memories returns content in both structuredContent and text", async () => {
  const { env } = makeEnv();
  const m = await seed(env, { gist: "hello gist" });
  const { result } = await rpc(env, "tools/call", { name: "taproot_dash_memories", arguments: {} });
  assert.equal(result.structuredContent.memories[0].id, m.id);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test("taproot_dash_update changes salience/core without bumping updated_at", async () => {
  const { env } = makeEnv();
  const m = await seed(env, { salience: "high", core: false });
  const { result } = await rpc(env, "tools/call", {
    name: "taproot_dash_update",
    arguments: { id: m.id, salience: "low", core: true },
  });
  assert.equal(result.structuredContent.memory.salience, "low");
  const stored = await rawRecord(env, m.id);
  assert.equal(stored.salience, "low");
  assert.equal(stored.core, true);
  assert.equal(stored.updated_at, m.updated_at);
});

test("taproot_dash_update validation errors come back as tool errors", async () => {
  const { env } = makeEnv();
  const m = await seed(env);
  const bad = await rpc(env, "tools/call", { name: "taproot_dash_update", arguments: { id: m.id, salience: "huge" } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /Invalid salience/);

  const gone = await rpc(env, "tools/call", { name: "taproot_dash_update", arguments: { id: "nope", core: true } });
  assert.equal(gone.result.isError, true);
  assert.match(gone.result.content[0].text, /not found/);
});

// ─── Result views: readable cards for every regular tool ─────────────────────

test("every regular tool points at its own result view; existing _meta is kept", async () => {
  const { env } = makeEnv();
  const { result } = await rpc(env, "tools/list");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const regular = result.tools.filter((t: any) => !t.name.startsWith("taproot_dash"));
  assert.ok(regular.length >= 11);
  for (const t of regular) {
    assert.equal(t._meta.ui.resourceUri, `ui://taproot/view/${t.name}`, t.name);
    assert.equal(t._meta["ui/resourceUri"], `ui://taproot/view/${t.name}`, t.name);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reflect = regular.find((t: any) => t.name === "taproot_reflect");
  assert.equal(reflect._meta["anthropic/alwaysLoad"], true);
});

test("each result view resource is listed and readable; unknown views are not", async () => {
  const { env } = makeEnv();
  const listed = await rpc(env, "resources/list");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uris = listed.result.resources.map((r: any) => r.uri);
  assert.ok(uris.includes("ui://taproot/view/taproot_recall"));

  const { result } = await rpc(env, "resources/read", { uri: "ui://taproot/view/taproot_recall" });
  const c = result.contents[0];
  assert.equal(c.mimeType, "text/html;profile=mcp-app");
  assert.match(c.text, /const TOOL = "taproot_recall";/);
  assert.deepEqual(c._meta.ui.csp.resourceDomains, ["https://unpkg.com"]);

  const bogus = await rpc(env, "resources/read", { uri: "ui://taproot/view/taproot_nope" });
  assert.equal(bogus.error.code, -32002);
});

test("regular tool results are unchanged for the model: text only, no structuredContent", async () => {
  const { env } = makeEnv();
  await seed(env);
  const { result } = await rpc(env, "tools/call", { name: "taproot_status", arguments: {} });
  assert.equal(result.structuredContent, undefined);
  assert.equal(JSON.parse(result.content[0].text).status, "operational");
});

test("the result view script parses as JavaScript", async () => {
  const { renderResultViewHtml } = await import("../src/result-view.ts");
  const html = renderResultViewHtml("taproot_reflect");
  const open = html.lastIndexOf("<script");
  const script = html.slice(html.indexOf(">", open) + 1, html.lastIndexOf("</script>")).replace(/^import .*$/m, "");
  assert.doesNotThrow(() => new Function(`return (async () => {${script}\n})`));
});
