// Lets the test suite import src/index.ts outside the Workers runtime by
// mapping the `cloudflare:workers` built-in to test/stubs/cloudflare-workers.cjs,
// for both ESM imports and CommonJS requires (tsx compiles this package as CJS).
import { register, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const stubUrl = new URL("./stubs/cloudflare-workers.cjs", import.meta.url);
const stubPath = fileURLToPath(stubUrl);

const require = createRequire(import.meta.url);
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "cloudflare:workers") return stubPath;
  return origResolve.call(this, request, ...rest);
};

const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(stubUrl.href)}, shortCircuit: true };
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));
