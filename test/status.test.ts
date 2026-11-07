// Fix 2: taproot_status counts live and archived separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, call, makeEnv, seed } from "./helpers.ts";

test("archiving N memories lowers the live count by N and raises archived by N", async () => {
  const { env } = makeEnv();
  const threads = [];
  for (let i = 0; i < 5; i++) threads.push(await seed(env, { category: "active_thread" }));
  await seed(env, { category: "episodic" });

  const before = await call(__test.handleStatus, env);
  assert.equal(before.memory_counts.active_thread, 5);
  assert.equal(before.archived_counts.active_thread, 0);

  const N = 3;
  for (const t of threads.slice(0, N)) {
    const r = await call(__test.handleForget, env, { memory_id: t.id, action: "archive" });
    assert.equal(r.status, "ok");
  }

  const after = await call(__test.handleStatus, env);
  assert.equal(after.memory_counts.active_thread, 5 - N);
  assert.equal(after.archived_counts.active_thread, N);
  assert.equal(after.memory_counts.episodic, 1);
  assert.equal(after.total_memories, 3);
  assert.equal(after.total_archived, N);
  assert.equal(after.total_stored, 6);
});

test("the Nov 7 scenario: archive, convert to episodic, create one", async () => {
  const { env } = makeEnv();
  const threads = [];
  for (let i = 0; i < 10; i++) threads.push(await seed(env, { category: "active_thread" }));
  for (const t of threads.slice(0, 4)) await call(__test.handleForget, env, { memory_id: t.id, action: "archive" });
  for (const t of threads.slice(4, 6)) await call(__test.handleRemember, env, { update_id: t.id, category: "episodic" });
  await call(__test.handleRemember, env, { category: "active_thread", content: "new", gist: "new" });
  const s = await call(__test.handleStatus, env);
  assert.equal(s.memory_counts.active_thread, 10 - 4 - 2 + 1);
  assert.equal(s.archived_counts.active_thread, 4);
  assert.equal(s.memory_counts.episodic, 2);
});

test("archived core memories count in neither status nor reflect core_count", async () => {
  const { env } = makeEnv();
  await seed(env, { core: true, category: "identity" });
  const archivedCore = await seed(env, { core: true, category: "identity" });
  await call(__test.handleForget, env, { memory_id: archivedCore.id, action: "archive" });

  const s = await call(__test.handleStatus, env);
  assert.equal(s.tiers.core_count, 1);
  const reflect = await call(__test.handleReflect, env);
  assert.equal(reflect.core_count, 1);
  assert.ok(!JSON.stringify(reflect).includes(archivedCore.id));
});

test("reflect catalog and status catalog_count exclude archived records", async () => {
  const { env } = makeEnv();
  const a = await seed(env, { salience: "high" });
  const b = await seed(env, { salience: "high" });
  await seed(env, { salience: "low", updated_at: "2020-01-01T00:00:00.000Z" }); // omitted
  await call(__test.handleForget, env, { memory_id: b.id, action: "archive" });

  const reflect = await call(__test.handleReflect, env);
  const lines = Object.values(reflect.catalog).flat() as string[];
  assert.ok(lines.some(l => l.includes(a.id)));
  assert.ok(!lines.some(l => l.includes(b.id)));
  assert.equal(reflect.catalog_count, 1);
  assert.equal(reflect.catalog_omitted.active_thread, 1);

  const s = await call(__test.handleStatus, env);
  assert.equal(s.tiers.catalog_count, 2, "included + omitted, live only");
  assert.equal(s.tiers.catalog_lines_included + s.tiers.catalog_lines_omitted, s.tiers.catalog_count);
});

test("reflect excludes an archived record even when it has no KV metadata", async () => {
  const { kv, env } = makeEnv();
  const m = await seed(env, { salience: "high", tags: ["_archive_pending"] });
  kv.store.get(`mem:${m.id}`)!.metadata = null;
  const reflect = await call(__test.handleReflect, env);
  assert.equal(reflect.catalog_count, 0);
});
