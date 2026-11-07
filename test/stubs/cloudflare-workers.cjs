// Stand-in for the Workers runtime's `cloudflare:workers` module (tests only).
class WorkerEntrypoint {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
module.exports = { WorkerEntrypoint };
