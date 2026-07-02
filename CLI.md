
## CLI

`cli.ts` provides command-line access to the same MCP tools Claude uses. Every command hits the live server and returns the identical JSON response Claude receives.

### Setup

Install dependencies (once):

```bash
npm install
```

Authenticate (once). This runs a PKCE/OAuth flow and saves an access token to `~/.taproot/config.json`:

```bash
npm run taproot -- auth --url https://<your-worker>.workers.dev --token <your-auth-token>
```

### Commands

#### `taproot status`

Report the current state of the memory system: counts per category, compression queue, and total memories.

```bash
npm run taproot -- status
```

#### `taproot reflect`

Load the two-tier context payload. Tier 1 (`core_memories`) is full text — identity anchors, relationship context, standing corrections, and hot threads, curated via `taproot_promote`. Tier 2 (`catalog`) is one gist line per remaining memory, grouped by category, so nothing is invisible even though it isn't loaded in full. This is what Claude calls at the start of every conversation.

```bash
npm run taproot -- reflect
```

#### `taproot recall`

Retrieve full-text memories ranked by activation (recency, retrieval frequency, salience, and query relevance). Every returned memory is "strengthened" — `last_retrieved` and `retrieval_count` update, making it more likely to surface again.

```bash
npm run taproot -- recall [--query <text>] [--category <c>] [--ids id1,id2] [--tags t1,t2] [--since <iso>] [--limit <n>]
```

| Flag | Description |
|---|---|
| `--query` | Free-text search, scored against `search_keywords`, `tags`, `gist`, and content |
| `--category` | Filter by category: `identity`, `relationship`, `active_thread`, `episodic`, `error` |
| `--ids` | Comma-separated memory IDs to fetch directly (e.g. spotted in the reflect catalog) |
| `--tags` | Comma-separated list of tags; all must match |
| `--since` | ISO 8601 timestamp — return only memories updated after this time |
| `--limit` | Maximum number of results (default: 5) |

#### `taproot remember`

Write a new memory or update an existing one. A `--gist` is required when creating a memory — it's what shows up in the Tier 2 catalog.

```bash
npm run taproot -- remember <content> --gist <gist> [--category <c>] [--salience <s>] [--tags t1,t2] \
  [--core] [--epistemic-status <s>] [--provenance <p>] \
  [--conversation-url <url>] [--search-keywords k1,k2] \
  [--update-id <id>] [--conversation-id <id>]
```

| Flag | Description |
|---|---|
| `--gist` | ~15-word one-line summary for the reflect catalog. Required when creating a new memory. |
| `--category` | `identity`, `relationship`, `active_thread`, `episodic` (default), `error` |
| `--salience` | `high`, `medium` (default), `low` |
| `--core` | Mark this memory Tier 1 (always loaded in full by `taproot_reflect`) |
| `--epistemic-status` | `observed`, `inferred`, `replicated`, `contested`, `unvalidated` (default) |
| `--provenance` | Conversation URL or description of where the claim came from |
| `--tags` | Comma-separated tags for retrieval within Taproot |
| `--conversation-url` | URL of the source Claude.ai conversation (`https://claude.ai/chat/{id}`) for provenance |
| `--search-keywords` | Comma-separated distinctive terms from the conversation to aid future retrieval |
| `--update-id` | UUID of an existing memory to update instead of creating a new one |
| `--conversation-id` | Source conversation ID |

#### `taproot forget`

Archive or permanently delete a memory.

```bash
npm run taproot -- forget <memory-id> --action <archive|delete> [--reason <text>]
```

| Action | Effect |
|---|---|
| `archive` | Soft delete — hidden from recall but retained in storage |
| `delete` | Hard delete — removed from KV entirely |

#### `taproot promote`

Curate Tier 1: toggle a memory's `core` flag and/or adjust its salience.

```bash
npm run taproot -- promote <memory-id> [--core <true|false>] [--salience <s>]
```

#### `taproot migrate`

Backfill v0.2 schema fields (`gist`, `core`, `last_retrieved`, `retrieval_count`, `epistemic_status`, `replication_count`, `provenance`) onto every existing memory record. Idempotent — safe to run more than once. Writes a full backup of all memory records to a `backup:` KV key before mutating anything; never rewrites `content`.

```bash
npm run taproot -- migrate
```

### Output

All commands print the JSON response to stdout, pretty-printed. This is the exact payload Claude receives from the MCP server — the content of the `text` field in the MCP tool result.

---

## MCP Server

The server is a Cloudflare Worker at `src/index.ts`. It implements MCP over JSON-RPC 2.0 with OAuth 2.1 (PKCE + dynamic client registration) for authentication.

### Development

```bash
npm run dev        # wrangler dev
npm run deploy     # wrangler deploy
npm run typecheck  # tsc --noEmit
```

### Environment variables

Set via `wrangler secret put`:

| Variable | Description |
|---|---|
| `TAPROOT_AUTH_TOKEN` | Password used to gate the OAuth consent screen |

For local development, create `.dev.vars`:

```
TAPROOT_AUTH_TOKEN=your-token-here
```
