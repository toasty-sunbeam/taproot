# Taproot

Taproot is a memory and identity persistence server for Claude, deployed as a Cloudflare Worker. It exposes an MCP (Model Context Protocol) server that Claude uses to read and write memories and recall past context across sessions.

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

Load the full core context payload — identity observations, relationship texture, active threads, and the error log. This is what Claude calls at the start of every conversation.

```bash
npm run taproot -- reflect
```

#### `taproot recall`

Search and filter memories.

```bash
npm run taproot -- recall [--query <text>] [--category <c>] [--tags t1,t2] [--since <iso>] [--limit <n>]
```

| Flag | Description |
|---|---|
| `--query` | Case-insensitive substring search across memory content |
| `--category` | Filter by category: `identity`, `relationship`, `active_thread`, `episodic`, `error` |
| `--tags` | Comma-separated list of tags; all must match |
| `--since` | ISO 8601 timestamp — return only memories updated after this time |
| `--limit` | Maximum number of results (default: 10) |

#### `taproot remember`

Write a new memory or update an existing one.

```bash
npm run taproot -- remember <content> [--category <c>] [--salience <s>] [--tags t1,t2] \
  [--conversation-url <url>] [--search-keywords k1,k2] \
  [--update-id <id>] [--conversation-id <id>]
```

| Flag | Description |
|---|---|
| `--category` | `identity`, `relationship`, `active_thread`, `episodic` (default), `error` |
| `--salience` | `high`, `medium` (default), `low` |
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
