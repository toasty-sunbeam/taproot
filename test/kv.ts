// Minimal in-memory KVNamespace: just the surface Taproot uses (get, put
// with metadata, delete, list with prefix + cursor, getWithMetadata).
export class MemoryKV {
  store = new Map<string, { value: string; metadata: unknown }>();
  writes = 0;

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async getWithMetadata(key: string) {
    const e = this.store.get(key);
    return { value: e?.value ?? null, metadata: e?.metadata ?? null };
  }
  async put(key: string, value: string, opts?: { metadata?: unknown }): Promise<void> {
    this.writes++;
    // structuredClone mirrors KV's serialize-on-write: later mutation of the
    // caller's object must not leak into storage.
    this.store.set(key, { value, metadata: opts?.metadata === undefined ? null : structuredClone(opts.metadata) });
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  // Pages of 2 so every caller's cursor loop is exercised.
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const names = [...this.store.keys()].filter(k => k.startsWith(opts.prefix ?? "")).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const size = 2;
    const slice = names.slice(start, start + size);
    const done = start + size >= names.length;
    return {
      keys: slice.map(name => ({ name, metadata: this.store.get(name)!.metadata ?? undefined })),
      list_complete: done,
      cursor: done ? "" : String(start + size),
    };
  }
}

export function makeEnv() {
  const kv = new MemoryKV();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const env = { TAPROOT_KV: kv, OAUTH_KV: new MemoryKV(), TAPROOT_AUTH_TOKEN: "test" } as any;
  return { kv, env };
}
