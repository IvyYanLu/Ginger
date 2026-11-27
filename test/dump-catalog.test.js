import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReport, parseDevVars } from "../scripts/dump-catalog.mjs";
import { listCatalog } from "../lib/square.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/catalog-small.json", import.meta.url)));
const env = { SQUARE_ACCESS_TOKEN: "t", SQUARE_LOCATION_ID: "LOC1" };

test("listCatalog follows the cursor", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    const page = new URL(url).searchParams.get("cursor") === "p2" ? fx.pages[1] : fx.pages[0];
    return new Response(JSON.stringify(page), { status: 200 });
  });
  const objs = await listCatalog(env);
  assert.equal(objs.length, 7);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/connect\.squareupsandbox\.com\/v2\/catalog\/list\?types=ITEM%2CCATEGORY%2CIMAGE%2CMODIFIER_LIST$/);
});

test("report shows structure and warnings", () => {
  const r = buildReport(fx.pages.flatMap((p) => p.objects), fx.location, "LOC1");
  for (const s of [
    "Bedford, MA, 01730", "TUE  11:30–21:30", "Maki", "SOLD OUT", "[NOT AT LOCATION]",
    "used by: California Roll", "is variable-priced", "has no category", "nested lists (Note)",
    "is TEXT", 'requires 1 from "Rice" but only 0',
  ]) assert.ok(r.includes(s), `missing: ${s}\n${r}`);
});

test("parseDevVars", () => {
  assert.deepEqual(parseDevVars('# c\nA=1\nB="x y"\n  C = \'z\'\nbad line'), { A: "1", B: "x y", C: "z" });
});

test("top-level categories with an empty parent_category are not flagged", () => {
  const cat = (id, name, parent) => ({ type: "CATEGORY", id, present_at_all_locations: true, category_data: { name, parent_category: parent } });
  const r = buildReport([cat("C1", "Maki", { ordinal: 1 }), cat("C2", "Hand Rolls", { id: "C1" })], null, "LOC1");
  assert.ok(!r.includes("?undefined"), r);
  assert.ok(r.includes("[parent: Maki]"), r);
});
