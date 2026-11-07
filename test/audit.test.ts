// Fix 1 audit: report memories with missing/empty content; never repair.
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test, call, makeEnv, seed, rawRecord } from "./helpers.ts";
import { auditContent } from "../src/audit.ts";

test("taproot_audit reports blanked records with backup candidates and writes nothing", async () => {
  const { kv, env } = makeEnv();
  const good = await seed(env, { content: "Fine." });
  const missing = await seed(env, { gist: "lost one", updated_at: "2026-11-07T10:00:00.000Z" });
  const empty = await seed(env, { content: "   ", gist: "empty one", tags: ["_archive_pending"] });

  const raw = await rawRecord(env, missing.id);
  delete raw.content;
  const meta = kv.store.get(`mem:${missing.id}`)!.metadata;
  await kv.put(`mem:${missing.id}`, JSON.stringify(raw), { metadata: meta });

  // Two snapshots: the newer one holds the more recent good copy.
  await kv.put("backup:schema-v2-2026-08-01T00:00:00.000Z", JSON.stringify([{ id: missing.id, content: "older text", updated_at: "2026-07-01T00:00:00.000Z" }]));
  await kv.put("backup:schema-v2-2026-08-03T00:00:00.000Z", JSON.stringify([{ id: missing.id, content: "newer text", updated_at: "2026-08-02T00:00:00.000Z" }, { id: empty.id, content: "" }]));

  const writes = kv.writes;
  const report = await call(__test.handleAudit, env);
  assert.equal(kv.writes, writes, "audit must not write");
  assert.equal(report.scanned, 3);
  assert.equal(report.affected, 2);
  const ids = report.rows.map((r: { id: string }) => r.id);
  assert.ok(!ids.includes(good.id));

  const m = report.rows.find((r: { id: string }) => r.id === missing.id);
  assert.equal(m.content_state, "missing");
  assert.equal(m.gist, "lost one");
  assert.equal(m.updated_at, "2026-11-07T10:00:00.000Z");
  assert.equal(m.backup_candidate.backup_key, "backup:schema-v2-2026-08-03T00:00:00.000Z");
  assert.equal(m.backup_candidate.content_preview, "newer text");

  const e = report.rows.find((r: { id: string }) => r.id === empty.id);
  assert.equal(e.content_state, "empty");
  assert.equal(e.archived, true);
  assert.equal(e.backup_candidate, null, "an empty backup copy isn't a candidate");

  // Still blank afterwards: report only.
  assert.equal((await rawRecord(env, missing.id)).content, undefined);
});

test("auditContent handles odd shapes (offline /backup export path)", () => {
  const report = auditContent(
    [{ id: "a", content: 7 }, { id: "b", content: null }, { id: "c", content: "ok" }],
    [{ key: "backup:schema-v2-x", records: "not an array" }],
  );
  assert.deepEqual(report.rows.map(r => [r.id, r.content_state]).sort(), [["a", "non_string"], ["b", "missing"]]);
});
