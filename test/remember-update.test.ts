// Fix 1: taproot_remember with update_id is a partial merge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, call, makeEnv, seed, rawRecord } from "./helpers.ts";

// Deliberately awkward content: unicode, emoji, trailing whitespace, newlines.
const CONTENT = "Line one — with an em dash.\n\nLine two: 🌱 teal & \"quotes\"\t \n  trailing spaces   ";

async function setup() {
  const { kv, env } = makeEnv();
  const created = await call(__test.handleRemember, env, {
    category: "active_thread",
    content: CONTENT,
    gist: "Original gist",
    salience: "medium",
    tags: ["taproot"],
    search_keywords: ["kw"],
    linked_memories: ["link-a"],
  });
  assert.equal(created.status, "ok");
  return { kv, env, id: created.memory_id as string };
}

test("gist-only update leaves content byte-identical", async () => {
  const { env, id } = await setup();
  const res = await call(__test.handleRemember, env, { update_id: id, category: "active_thread", gist: "New gist" });
  assert.equal(res.status, "ok");
  const r = await rawRecord(env, id);
  assert.equal(r.content, CONTENT);
  assert.equal(r.gist, "New gist");
});

test("gist-only update works without category (category optional on update)", async () => {
  const { env, id } = await setup();
  const res = await call(__test.handleRemember, env, { update_id: id, gist: "New gist" });
  assert.equal(res.status, "ok");
  const r = await rawRecord(env, id);
  assert.equal(r.content, CONTENT);
  assert.equal(r.category, "active_thread");
});

test("salience-only update leaves content and every other field intact", async () => {
  const { env, id } = await setup();
  const before = await rawRecord(env, id);
  const res = await call(__test.handleRemember, env, { update_id: id, salience: "high" });
  assert.equal(res.status, "ok");
  const after = await rawRecord(env, id);
  assert.equal(after.content, CONTENT);
  assert.equal(after.salience, "high");
  for (const k of ["gist", "tags", "search_keywords", "linked_memories", "category", "created_at", "core"]) {
    assert.deepEqual(after[k], before[k], `${k} changed`);
  }
});

test("category-only update leaves content intact and moves the record, not copies it", async () => {
  const { kv, env, id } = await setup();
  const res = await call(__test.handleRemember, env, { update_id: id, category: "episodic" });
  assert.equal(res.status, "ok");
  const r = await rawRecord(env, id);
  assert.equal(r.content, CONTENT);
  assert.equal(r.category, "episodic");
  // One key, and its list metadata (what recall/status/list filter on) moved too.
  const memKeys = [...kv.store.keys()].filter(k => k.startsWith("mem:"));
  assert.deepEqual(memKeys, [`mem:${id}`]);
  assert.equal((kv.store.get(`mem:${id}`)!.metadata as { category: string }).category, "episodic");
  const status = await call(__test.handleStatus, env);
  assert.equal(status.memory_counts.active_thread, 0);
  assert.equal(status.memory_counts.episodic, 1);
});

test("linked_memories-only and tags-only updates leave content intact", async () => {
  const { env, id } = await setup();
  await call(__test.handleRemember, env, { update_id: id, linked_memories: ["link-b"] });
  await call(__test.handleRemember, env, { update_id: id, tags: ["x"] });
  const r = await rawRecord(env, id);
  assert.equal(r.content, CONTENT);
  assert.deepEqual(r.linked_memories, ["link-b"]);
  assert.deepEqual(r.tags, ["x"]);
});

test("content update still replaces content", async () => {
  const { env, id } = await setup();
  await call(__test.handleRemember, env, { update_id: id, content: "Brand new text." });
  assert.equal((await rawRecord(env, id)).content, "Brand new text.");
});

for (const [label, bad] of [["empty", ""], ["whitespace-only", "  \n\t "], ["null", null], ["number", 42]] as const) {
  test(`update with ${label} content is rejected and nothing is written`, async () => {
    const { kv, env, id } = await setup();
    const before = kv.store.get(`mem:${id}`)!.value;
    const writes = kv.writes;
    const res = await call(__test.handleRemember, env, { update_id: id, content: bad });
    assert.equal(res.status, "error");
    assert.match(res.message, /omit the content field/);
    assert.equal(kv.writes, writes);
    assert.equal(kv.store.get(`mem:${id}`)!.value, before);
  });
}

test("update with empty gist is rejected", async () => {
  const { env, id } = await setup();
  const res = await call(__test.handleRemember, env, { update_id: id, gist: "  " });
  assert.equal(res.status, "error");
  assert.equal((await rawRecord(env, id)).gist, "Original gist");
});

test("create still requires content, category and gist", async () => {
  const { kv, env } = makeEnv();
  assert.equal((await call(__test.handleRemember, env, { category: "episodic", gist: "g" })).status, "error");
  assert.equal((await call(__test.handleRemember, env, { category: "episodic", gist: "g", content: "  " })).status, "error");
  assert.equal((await call(__test.handleRemember, env, { content: "c", gist: "g" })).status, "error");
  assert.equal((await call(__test.handleRemember, env, { category: "episodic", content: "c" })).status, "error");
  assert.equal(kv.writes, 0);
  const ok = await call(__test.handleRemember, env, { category: "episodic", content: "c", gist: "g" });
  assert.equal(ok.status, "ok");
  assert.equal(ok.action, "created");
});

test("invalid category on update is still rejected", async () => {
  const { env, id } = await setup();
  const res = await call(__test.handleRemember, env, { update_id: id, category: "bogus" });
  assert.equal(res.status, "error");
});

test("update of unknown id is an error", async () => {
  const { env } = makeEnv();
  const res = await call(__test.handleRemember, env, { update_id: "nope", gist: "x" });
  assert.equal(res.status, "error");
});

test("auto-generated gist is recomputed only when content actually changes", async () => {
  const { env } = makeEnv();
  const m = await seed(env, { content: "Old sentence here. More.", gist: "Old sentence here.", gist_autogenerated: true });

  await call(__test.handleRemember, env, { update_id: m.id, salience: "high" });
  assert.equal((await rawRecord(env, m.id)).gist, "Old sentence here.");

  await call(__test.handleRemember, env, { update_id: m.id, content: "Old sentence here. More." });
  assert.equal((await rawRecord(env, m.id)).gist, "Old sentence here.", "same content: no recompute");

  await call(__test.handleRemember, env, { update_id: m.id, content: "Fresh first sentence. Rest." });
  const r = await rawRecord(env, m.id);
  assert.equal(r.gist, "Fresh first sentence.");
  assert.equal(r.gist_autogenerated, true);
});

test("hand-written gist survives a content change", async () => {
  const { env, id } = await setup();
  await call(__test.handleRemember, env, { update_id: id, content: "Totally different." });
  assert.equal((await rawRecord(env, id)).gist, "Original gist");
});

test("recall with a query doesn't crash on a record whose content was blanked", async () => {
  const { env } = makeEnv();
  const m = await seed(env, { gist: "taproot thing" });
  // Simulate the pre-v0.4 bug's output: content key dropped from the record.
  const raw = await rawRecord(env, m.id);
  delete raw.content;
  const meta = (env.TAPROOT_KV as { store: Map<string, { metadata: unknown }> }).store.get(`mem:${m.id}`)!.metadata;
  await env.TAPROOT_KV.put(`mem:${m.id}`, JSON.stringify(raw), { metadata: meta });
  const res = await call(__test.handleRecall, env, { query: "taproot", strengthen: false });
  assert.equal(res.status, "ok");
  assert.equal(res.count, 1);
});
