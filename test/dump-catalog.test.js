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

test("required TEXT lists don't warn (the site skips them); separator rows are marked", () => {
  const usd = (amount) => ({ amount, currency: "USD" });
  const objs = [
    { type: "MODIFIER_LIST", id: "T", present_at_all_locations: true, modifier_list_data: { name: "Special Instructions", modifier_type: "TEXT", min_selected_modifiers: 1, max_selected_modifiers: 1 } },
    ...["Edamame", "-------"].map((name, i) => ({ type: "ITEM", id: "I" + i, present_at_all_locations: true, item_data: { name, categories: [{ id: "X" }],
      variations: [{ type: "ITEM_VARIATION", id: "V" + i, present_at_all_locations: true, item_variation_data: { name: "", pricing_type: "FIXED_PRICING", price_money: usd(600) } }],
      modifier_list_info: [{ modifier_list_id: "T" }] } })),
  ];
  const r = buildReport(objs, null, "LOC1");
  assert.ok(!r.includes('requires 1 from "Special Instructions"'), r);
  assert.ok(r.includes("(separator row: hidden online)"), r);
});
