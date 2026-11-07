# Taproot v0.4 is deployed

Deployed Nov 7, 2026. The three hygiene-pass fixes are live. Code: [toasty-sunbeam/taproot#17](https://github.com/toasty-sunbeam/taproot/pull/17).

Your client may have loaded the Taproot tools before the deploy. If so, the tool descriptions it shows are out of date; the behavior below is current.

## 1. `taproot_remember` with `update_id` now merges

- Send only the fields you're changing; everything you leave out keeps its stored value.
- `category` and `content` are required only when creating a memory.
- Empty or whitespace-only `content` is rejected, not treated as a wipe.
- An auto-generated gist is recomputed only when `content` changes.
- You no longer need to re-send the full content on every update.
- New read-only `taproot_audit` tool: it lists memories with missing or empty content. An audit of the pre-deploy backup found **0 affected** out of 240, so nothing needs repair.

## 2. `taproot_status` now separates live from archived

- `memory_counts` and `total_memories` count live memories only.
- New fields: `archived_counts` (per category), `total_archived` and `total_stored`.
- Right after deploy: 157 live memories (19 active threads), 83 archived (82 of them active threads), 240 stored.
- `compression_queue` still counts archived records. That was left unchanged on purpose.

## 3. New `taproot_list` tool for admin sweeps

Use it instead of topic-query recall.

- **Parameters:** `category` (optional), `include_archived` (default false), `limit` (default 50, max 250), `cursor`.
- **Returns:** one row per memory with no content (`id`, `category`, `gist`, `salience`, `core`, `created_at`, `updated_at`, `last_retrieved`, `retrieval_count`, `archived`, `tags`), plus `total`, `total_by_category`, `has_more` and `next_cursor`.
- Ordered by `updated_at` newest first, then `id`. It never changes `last_retrieved` or `retrieval_count`.
- Page until `next_cursor` is null. Use `taproot_recall` with `ids` to get full text.
- All 19 active threads fit in one call: `taproot_list({category: "active_thread"})`.

## Monthly hygiene check-in task

Task ID: `trig_019EykgrHEYpSf9ZRTDwSAB3`.

- Replace the `since`-window sweeps and saved-file parsing with one `taproot_list({category: "active_thread"})` call.
- Treat its `total` as the live thread count. It should match `status.memory_counts.active_thread`.

## Memory `806cad99` is already updated

- Its tool-behavior notes now describe v0.4.
- Items 3 and 4 of the open design items are marked resolved.
- Two new items were added: split `compression_queue`, and remove or gate hard delete in `taproot_forget`.
- No need to re-send it.
