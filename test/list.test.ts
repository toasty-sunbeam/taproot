// Fix 3: taproot_list — lightweight, complete, deterministic, read-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, call, makeEnv, seed, rawRecord } from "./helpers.ts";

const SUMMARY_FIELDS = ["archived", "category", "core", "created_at", "gist", "id", "last_retrieved", "retrieval_count", "salience", "tags", "updated_at"];

test("lists every live active thread with summary fields only, matching status", async () => {
  const { env } = makeEnv();
  const threads = [];
  for (let i = 0; i < 6; i++) {
    threads.push(await seed(env, { category: "active_thread", retrieval_count: i, last_retrieved: i ? "2026-11-01T00:00:00.000Z" : null }));
  }
  await seed(env, { category: "episodic" });
  await call(__test.handleForget, env, { memory_id: threads[0].id, action: "archive" });

  const res = await call(__test.handleList, env, { category: "active_thread" });
  assert.equal(res.status, "ok");
  assert.equal(res.total, 5);
  assert.equal(res.count, 5);
  assert.equal(res.has_more, false);
  assert.equal(res.next_cursor, null);
  for (const item of res.items) {
    assert.deepEqual(Object.keys(item).sort(), SUMMARY_FIELDS);
    assert.equal(item.archived, false);
  }
  assert.ok(!res.items.some((i: { id: string }) => i.id === threads[0].id));

  const status = await call(__test.handleStatus, env);
  assert.equal(res.total, status.memory_counts.active_thread);
});

test("include_archived shows archived records, flagged", async () => {
  const { env } = makeEnv();
  const a = await seed(env);
  await seed(env);
  await call(__test.handleForget, env, { memory_id: a.id, action: "archive" });
  const res = await call(__test.handleList, env, { include_archived: true });
  assert.equal(res.total, 2);
  assert.equal(res.items.find((i: { id: string }) => i.id === a.id).archived, true);
  const status = await call(__test.handleStatus, env);
  assert.equal(res.items.filter((i: { archived: boolean }) => i.archived).length, status.total_archived);
});

test("never strengthens: no writes, activation fields unchanged", async () => {
  const { kv, env } = makeEnv();
  const m = await seed(env, { retrieval_count: 4, last_retrieved: "2026-09-09T09:09:09.000Z" });
  const before = await rawRecord(env, m.id);
  const writes = kv.writes;
  await call(__test.handleList, env, {});
  await call(__test.handleList, env, { category: "active_thread", include_archived: true, limit: 1 });
  assert.equal(kv.writes, writes);
  assert.deepEqual(await rawRecord(env, m.id), before);
});

test("paging is complete, duplicate-free and ordered (updated_at desc, id asc)", async () => {
  const { env } = makeEnv();
  const ts = ["2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.000Z", "2026-11-04T00:00:00.000Z", "2026-11-03T00:00:00.000Z"];
  const all = [];
  // Ties on updated_at exercise the id tiebreak.
  for (let i = 0; i < 11; i++) all.push(await seed(env, { updated_at: ts[i % ts.length], category: i % 3 ? "active_thread" : "episodic" }));

  const seen: Array<{ id: string; updated_at: string }> = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await call(__test.handleList, env, { limit: 4, ...(cursor ? { cursor } : {}) });
    assert.equal(res.total, 11);
    seen.push(...res.items);
    cursor = res.next_cursor ?? undefined;
    pages++;
  } while (cursor);

  assert.equal(pages, 3);
  assert.equal(seen.length, 11);
  assert.equal(new Set(seen.map(s => s.id)).size, 11);
  const expected = [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)).map(m => m.id);
  assert.deepEqual(seen.map(s => s.id), expected);
});

test("a record changed between pages doesn't break the remaining pages", async () => {
  const { env } = makeEnv();
  for (let i = 0; i < 6; i++) await seed(env, { updated_at: `2026-11-0${i + 1}T00:00:00.000Z` });
  const p1 = await call(__test.handleList, env, { limit: 3 });
  // Archive a record already seen on page 1 (bumps its updated_at).
  await call(__test.handleForget, env, { memory_id: p1.items[2].id, action: "archive" });
  const p2 = await call(__test.handleList, env, { limit: 3, cursor: p1.next_cursor });
  assert.equal(p2.count, 3);
  assert.equal(p2.next_cursor, null);
  const ids = new Set([...p1.items, ...p2.items].map((i: { id: string }) => i.id));
  assert.equal(ids.size, 6);
});

test("total_by_category covers every category when unfiltered", async () => {
  const { env } = makeEnv();
  await seed(env, { category: "identity" });
  await seed(env, { category: "error" });
  await seed(env, { category: "error" });
  const res = await call(__test.handleList, env, {});
  assert.deepEqual(res.total_by_category, { identity: 1, relationship: 0, active_thread: 0, error: 2, episodic: 0 });
});

test("a 100-thread page stays small, even when content is huge", async () => {
  const { env } = makeEnv();
  const big = "word ".repeat(1200); // ~6 KB each; ~600 KB total as full recall
  for (let i = 0; i < 100; i++) await seed(env, { content: big, gist: "A fairly typical fifteen word gist line describing what this project thread is about" });
  const text = await __test.handleList({ category: "active_thread", limit: 100 }, env);
  const res = JSON.parse(text);
  assert.equal(res.count, 100);
  assert.ok(text.length < 40_000, `page was ${text.length} chars`);
  assert.ok(!text.includes("word word"));
});

test("limit is capped and invalid input is rejected", async () => {
  const { env } = makeEnv();
  await seed(env);
  assert.equal((await call(__test.handleList, env, { category: "bogus" })).status, "error");
  assert.equal((await call(__test.handleList, env, { limit: 0 })).status, "error");
  assert.equal((await call(__test.handleList, env, { cursor: "garbage!!" })).status, "error");
  assert.equal((await call(__test.handleList, env, { limit: 100000 })).status, "ok");
});

test("records without KV metadata still appear", async () => {
  const { kv, env } = makeEnv();
  const m = await seed(env);
  kv.store.get(`mem:${m.id}`)!.metadata = null;
  const res = await call(__test.handleList, env, {});
  assert.equal(res.total, 1);
  assert.equal(res.items[0].id, m.id);
});
