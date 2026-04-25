#!/usr/bin/env node
/**
 * taproot-cli — command-line interface for the Taproot MCP server.
 *
 * First run (once):
 *   taproot auth --url https://<your-worker>.workers.dev --token <auth-token>
 *
 * Then:
 *   taproot status
 *   taproot reflect
 *   taproot recall       [--query <q>] [--category <c>] [--tags t1,t2] [--since <iso>] [--limit <n>]
 *   taproot remember     <content> [--category <c>] [--salience <s>] [--tags t1,t2]
 *                        [--conversation-url <url>] [--search-keywords k1,k2]
 *                        [--update-id <id>] [--conversation-id <id>]
 *   taproot forget       <memory-id> --action <archive|delete> [--reason <r>]
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".taproot");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  serverUrl: string;
  accessToken: string;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    die("No configuration found. Run:\n  taproot auth --url <server-url> --token <auth-token>");
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
}

function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`taproot: ${msg}`);
  process.exit(1);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── OAuth PKCE Flow ───────────────────────────────────────────────────────────

async function doOAuthFlow(serverUrl: string, password: string): Promise<{ accessToken: string }> {
  const base = serverUrl.replace(/\/$/, "");

  // 1. Dynamic client registration
  const regRes = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "taproot-cli",
      redirect_uris: ["http://localhost:19191/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  if (!regRes.ok) die(`Client registration failed: ${regRes.status} ${await regRes.text()}`);
  const reg = (await regRes.json()) as { client_id: string; client_secret: string };

  // 2. PKCE values
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(16));
  const redirectUri = "http://localhost:19191/callback";

  // 3. GET /authorize to extract the hidden oauth_req field
  const authUrl = new URL(`${base}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const pageRes = await fetch(authUrl.toString());
  if (!pageRes.ok) die(`Authorization page failed: ${pageRes.status}`);
  const html = await pageRes.text();

  const m = html.match(/name="oauth_req"\s+value="([^"]+)"/);
  if (!m) die("Could not parse oauth_req from authorization page");
  const oauthReq = m[1];

  // 4. Local server to receive the auth code (fetch follows the 302 here automatically)
  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost:19191");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Authorized. You may close this.");
      server.close();
      if (!code) return reject(new Error("No code in callback"));
      if (returnedState !== state) return reject(new Error("State mismatch — possible CSRF"));
      resolve(code);
    });
    server.on("error", reject);
    server.listen(19191, "localhost");
  });

  // 5. POST /authorize with password; fetch follows the 302 to our local server
  await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, oauth_req: oauthReq }).toString(),
  });

  const code = await codePromise;

  // 6. Exchange code for access token
  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      client_secret: reg.client_secret,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!tokenRes.ok) die(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tok = (await tokenRes.json()) as { access_token: string };

  return { accessToken: tok.access_token };
}

// ── MCP Tool Call ─────────────────────────────────────────────────────────────

let _reqId = 1;

async function callTool(
  config: Config,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const base = config.serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: _reqId++,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (res.status === 401) die("Unauthorized. Re-run: taproot auth --url <url> --token <token>");
  if (!res.ok) die(`HTTP ${res.status}: ${await res.text()}`);

  const rpc = (await res.json()) as {
    result?: { content?: Array<{ text: string }> };
    error?: { message: string };
  };
  if (rpc.error) die(`Tool error: ${rpc.error.message}`);

  const text = rpc.result?.content?.[0]?.text ?? "{}";
  return JSON.stringify(JSON.parse(text), null, 2);
}

// ── Argument Helpers ──────────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

function flagList(args: string[], name: string): string[] | undefined {
  const v = flag(args, name);
  return v ? v.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdAuth(args: string[]): Promise<void> {
  const url = flag(args, "url");
  const token = flag(args, "token");
  if (!url || !token) die("Usage: taproot auth --url <server-url> --token <auth-token>");
  console.error("Authenticating with Taproot...");
  const { accessToken } = await doOAuthFlow(url, token);
  saveConfig({ serverUrl: url, accessToken });
  console.error(`Authenticated. Config saved to ${CONFIG_FILE}`);
}

async function cmdStatus(): Promise<void> {
  console.log(await callTool(loadConfig(), "taproot_status"));
}

async function cmdReflect(): Promise<void> {
  console.log(await callTool(loadConfig(), "taproot_reflect"));
}

async function cmdRecall(args: string[]): Promise<void> {
  const params: Record<string, unknown> = {};
  const query = flag(args, "query");
  const category = flag(args, "category");
  const tags = flagList(args, "tags");
  const since = flag(args, "since");
  const limit = flag(args, "limit");
  if (query) params.query = query;
  if (category) params.category = category;
  if (tags) params.tags = tags;
  if (since) params.since = since;
  if (limit) params.limit = Number(limit);
  console.log(await callTool(loadConfig(), "taproot_recall", params));
}

async function cmdRemember(args: string[]): Promise<void> {
  const contentFlag = flag(args, "content");
  let content: string;
  if (contentFlag !== undefined) {
    content = contentFlag;
  } else {
    const firstFlagIdx = args.findIndex((a) => a.startsWith("--"));
    const positional = firstFlagIdx === -1 ? args : args.slice(0, firstFlagIdx);
    content = positional.join(" ");
  }
  if (!content.trim()) {
    die(
      "Usage: taproot remember <content> [--category <c>] [--salience <s>] [--tags t1,t2]\n" +
        "                        [--conversation-url <url>] [--search-keywords k1,k2]\n" +
        "                        [--update-id <id>] [--conversation-id <id>]",
    );
  }
  const params: Record<string, unknown> = {
    content,
    category: flag(args, "category") ?? "episodic",
  };
  const salience = flag(args, "salience");
  const tags = flagList(args, "tags");
  const linkedMemories = flagList(args, "linked-memories");
  const convUrl = flag(args, "conversation-url");
  const searchKeywords = flagList(args, "search-keywords");
  const updateId = flag(args, "update-id");
  const convId = flag(args, "conversation-id");
  const transcriptRef = flag(args, "transcript-ref");
  if (salience) params.salience = salience;
  if (tags) params.tags = tags;
  if (linkedMemories) params.linked_memories = linkedMemories;
  if (convUrl) params.conversation_url = convUrl;
  if (searchKeywords) params.search_keywords = searchKeywords;
  if (updateId) params.update_id = updateId;
  if (convId) params.conversation_id = convId;
  if (transcriptRef) params.transcript_ref = transcriptRef;
  console.log(await callTool(loadConfig(), "taproot_remember", params));
}

async function cmdForget(args: string[]): Promise<void> {
  const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const action = flag(args, "action");
  const reason = flag(args, "reason");
  if (!id || !action) {
    die("Usage: taproot forget <memory-id> --action <archive|delete> [--reason <r>]");
  }
  const params: Record<string, unknown> = { memory_id: id, action };
  if (reason) params.reason = reason;
  console.log(await callTool(loadConfig(), "taproot_forget", params));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage: taproot <command> [options]

Commands:
  auth         --url <server-url> --token <auth-token>
  status
  reflect
  recall       [--query <q>] [--category <c>] [--tags t1,t2] [--since <iso>] [--limit <n>]
  remember     <content> [--category <c>] [--salience <s>] [--tags t1,t2]
               [--conversation-url <url>] [--search-keywords k1,k2]
               [--update-id <id>] [--conversation-id <id>]
  forget       <memory-id> --action <archive|delete> [--reason <r>]`;

const [, , cmd, ...rest] = process.argv;

(async () => {
  switch (cmd) {
    case "auth":      return cmdAuth(rest);
    case "status":    return cmdStatus();
    case "reflect":   return cmdReflect();
    case "recall":    return cmdRecall(rest);
    case "remember":  return cmdRemember(rest);
    case "forget":    return cmdForget(rest);
    default:
      console.error(USAGE);
      process.exit(cmd ? 1 : 0);
  }
})().catch((err) => die(err instanceof Error ? err.message : String(err)));
