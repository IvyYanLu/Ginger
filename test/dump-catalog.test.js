import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReport, parseDevVars, pairKey } from "../scripts/dump-catalog.mjs";
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

test("pairKey matches lunch and all-day names", () => {
  const same = [["Gyudon", "Gyu Donburi"], ["Katsu Don", "Katsu Don Buri"], ["Nabe Yaki Udon", "Nabeyaki Udon"],
    ["Chicken Teriyaki Lunch Box", "Chicken Teriyaki D"], ["Sashimi Lunch", "Sashimi Dinner"], ["Chirashi Lunch", "Chirashi"],
    ["Sushi & Sashimi Lunch", "Sushi & Sashimi"], ["Tonkotsu Ramen", "Tonkotsu Ramen"]];
  for (const [a, b] of same) assert.equal(pairKey(a), pairKey(b), `${a} / ${b}`);
  assert.notEqual(pairKey("Curry Rice"), pairKey("Beef Curry Rice"));
  assert.notEqual(pairKey("Sushi Lunch Tuna"), pairKey("Sushi Lunch California"));
});

test("report pairs lunch items with all-day versions and flags prices", () => {
  const usd = (amount) => ({ amount, currency: "USD" });
  const cat = (id, name, parent) => ({ type: "CATEGORY", id, present_at_all_locations: true, category_data: { name, ...(parent && { parent_category: { id: parent } }) } });
  const item = (id, name, cats, cents) => ({ type: "ITEM", id, present_at_all_locations: true, item_data: { name, reporting_category: { id: cats[0] }, categories: cats.map((c) => ({ id: c })),
    variations: [{ type: "ITEM_VARIATION", id: "V" + id, present_at_all_locations: true, item_variation_data: { name: "", pricing_type: "FIXED_PRICING", price_money: usd(cents) } }] } });
  const objs = [
    cat("ROOT", "Menu"), cat("DON", "Don Buri"), cat("G_DON", "Don Buri", "ROOT"), cat("G_LDON", "Lunch Don & Udon", "ROOT"), cat("RAMEN", "Ramen"),
    item("A", "Gyudon", ["DON", "G_LDON"], 1500), item("B", "Gyu Donburi", ["DON", "G_DON"], 1900),
    item("C", "Tonkotsu Ramen", ["RAMEN", "G_LDON"], 1695), item("D", "Tonkotsu Ramen", ["RAMEN", "G_DON"], 1695),
  ];
  const r = buildReport(objs, null, "LOC1", { LUNCH_HOURS: "MON-SUN 11:00-14:30", LUNCH_ONLY_CATEGORIES: "Lunch Don & Udon", HIDE_CATEGORIES: "x" });
  assert.match(r, /Gyudon \$15\.00 +\[Lunch Don & Udon\]   vs  Gyu Donburi \$19\.00 \[Don Buri\]\n/);
  assert.match(r, /Tonkotsu Ramen \$16\.95 +\[Lunch Don & Udon\]   vs  Tonkotsu Ramen \$16\.95 \[Ramen\]  ! SAME PRICE/);
});
