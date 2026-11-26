// Bundles the Pages Functions with esbuild (as Cloudflare does) into one ESM
// module, so function tests exercise the bundled code, not the source files.
// lib/ is bundled once, so resetMenuCache() resets the same cache the handlers use.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "ginger-fn-")), "functions.mjs");
await build({
  stdin: {
    contents: [
      'export { onRequestGet as menuGet } from "./functions/api/menu.js";',
      'export { onRequestPost as checkoutPost } from "./functions/api/checkout.js";',
      'export { resetMenuCache } from "./lib/square.js";',
    ].join("\n"),
    resolveDir: root,
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "neutral", // no Node built-ins, like the Workers runtime
  target: "es2022",
  outfile: out,
  logLevel: "silent",
});
export const { menuGet, checkoutPost, resetMenuCache } = await import(pathToFileURL(out).href);
