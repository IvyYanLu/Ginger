import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPhases, copyCatalog, locationUpdate } from "../scripts/copy-catalog.mjs";

const usd = (amount) => ({ amount, currency: "USD" });
const P = "PRODLOC", S = "SANDLOC";
const objects = [
  { type: "TAX", id: "T1", present_at_all_locations: true, tax_data: { name: "MA Meals", percentage: "7.0", calculation_phase: "TAX_SUBTOTAL_PHASE", inclusion_type: "ADDITIVE", tax_type_id: "x" } },
  { type: "CATEGORY", id: "G_ROOT", present_at_all_locations: true, category_data: { name: "Ginger Japanese Menu" } },
  { type: "CATEGORY", id: "G_LDON", present_at_all_locations: true, category_data: { name: "Lunch Don & Udon", parent_category: { id: "G_ROOT", ordinal: 3 }, root_category: "G_ROOT" } },
  { type: "CATEGORY", id: "DON", present_at_all_locations: true, category_data: { name: "Don Buri" } },
  { type: "CATEGORY", id: "GONE", is_deleted: true, category_data: { name: "Old" } },
  { type: "MODIFIER_LIST", id: "ML1", present_at_all_locations: true, version: 9, modifier_list_data: { name: "Protein", selection_type: "SINGLE", min_selected_modifiers: 1, max_selected_modifiers: 1, modifiers: [
    { type: "MODIFIER", id: "M1", present_at_all_locations: true, modifier_data: { name: "Beef", price_money: usd(0), ordinal: 1, location_overrides: [{ location_id: P, sold_out: true }, { location_id: "OTHER", sold_out: false }] } },
    { type: "MODIFIER", id: "M2", present_at_all_locations: false, present_at_location_ids: ["OTHER"], modifier_data: { name: "Elsewhere" } },
  ] } },
  { type: "ITEM", id: "I1", present_at_all_locations: true, updated_at: "x", item_data: {
    name: "Gyudon", description_html: "<p>Beef bowl</p>", description_plaintext: "Beef bowl", ecom_visibility: "VISIBLE", image_ids: ["IMG"],
    reporting_category: { id: "DON", ordinal: 5 }, categories: [{ id: "DON" }, { id: "G_LDON", ordinal: 2 }], tax_ids: ["T1"],
    modifier_list_info: [{ modifier_list_id: "ML1", min_selected_modifiers: -1, max_selected_modifiers: -1, enabled: true, modifier_overrides: [{ modifier_id: "M1", on_by_default: true }] }],
    variations: [{ type: "ITEM_VARIATION", id: "V1", present_at_all_locations: true, item_variation_data: { item_id: "I1", name: "Regular", pricing_type: "FIXED_PRICING", price_money: usd(1600), location_overrides: [{ location_id: P, price_money: usd(1500), track_inventory: true }] } }],
  } },
  { type: "ITEM", id: "I_ELSEWHERE", present_at_all_locations: false, present_at_location_ids: ["OTHER"], item_data: { name: "Other shop", variations: [] } },
];
const location = { id: P, name: "Ginger Japanese Restaurant", timezone: "America/New_York", phone_number: "+1 781-271-9988", address: { address_line_1: "88 Great Rd" }, business_hours: { periods: [{ day_of_week: "MON", start_local_time: "11:00", end_local_time: "14:30" }] }, status: "ACTIVE", merchant_id: "M" };
const from = { SQUARE_ENV: "production", SQUARE_ACCESS_TOKEN: "prod-token", SQUARE_LOCATION_ID: P };
const to = { SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "sand-token", SQUARE_LOCATION_ID: S };

test("phases: taxes, parent categories before children, modifier lists, items; deleted and other-location objects skipped", () => {
  const phases = buildPhases(objects, P, S);
  assert.deepEqual(phases.map((p) => [p.name, p.objects.map((o) => o.id)]), [
    ["taxes", ["T1"]],
    ["categories (level 1)", ["G_ROOT", "DON"]],
    ["categories (level 2)", ["G_LDON"]],
    ["modifier lists", ["ML1"]],
    ["items 1–1", ["I1"]],
  ]);
});

test("objects are rebuilt with temp ids, real ids for earlier phases, and the sandbox location", () => {
  const phases = buildPhases(objects, P, S);
  const real = (id) => ({ T1: "sT1", G_ROOT: "sROOT", G_LDON: "sLDON", DON: "sDON", ML1: "sML1", M1: "sM1" })[id];
  const build = (name, id) => { const p = phases.find((x) => x.name === name); return p.build(p.objects.find((o) => o.id === id), real); };

  assert.deepEqual(build("taxes", "T1").tax_data, { name: "MA Meals", calculation_phase: "TAX_SUBTOTAL_PHASE", inclusion_type: "ADDITIVE", percentage: "7.0" });
  assert.deepEqual(build("categories (level 2)", "G_LDON"), {
    type: "CATEGORY", id: "#G_LDON", present_at_all_locations: true,
    category_data: { name: "Lunch Don & Udon", parent_category: { id: "sROOT", ordinal: 3 } },
  });
  const ml = build("modifier lists", "ML1");
  assert.equal(ml.version, undefined);
  assert.deepEqual(ml.modifier_list_data.modifiers, [{
    type: "MODIFIER", id: "#M1", present_at_all_locations: true,
    modifier_data: { name: "Beef", price_money: usd(0), ordinal: 1, modifier_list_id: "#ML1", location_overrides: [{ sold_out: true, location_id: S }] },
  }]);
  assert.deepEqual(build("items 1–1", "I1"), {
    type: "ITEM", id: "#I1", present_at_all_locations: true,
    item_data: {
      name: "Gyudon", ecom_visibility: "VISIBLE", description_html: "<p>Beef bowl</p>",
      reporting_category: { id: "sDON", ordinal: 5 },
      categories: [{ id: "sDON" }, { id: "sLDON", ordinal: 2 }],
      tax_ids: ["sT1"],
      modifier_list_info: [{ min_selected_modifiers: -1, max_selected_modifiers: -1, enabled: true, modifier_list_id: "sML1", modifier_overrides: [{ on_by_default: true, modifier_id: "sM1" }] }],
      variations: [{ type: "ITEM_VARIATION", id: "#V1", present_at_all_locations: true,
        item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING", price_money: usd(1600), item_id: "#I1", location_overrides: [{ price_money: usd(1500), location_id: S }] } }],
    },
  });
});

test("location update copies only what the sandbox needs", () => {
  assert.deepEqual(Object.keys(locationUpdate(location)).sort(), ["address", "business_hours", "name", "phone_number", "timezone"]);
});

function mockSquare(t, { sandboxItems = [] } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname, method: init.method ?? "GET", auth: init.headers?.Authorization, body: init.body && JSON.parse(init.body) });
    if (u.pathname === "/v2/catalog/list") {
      return Response.json({ objects: u.host.includes("sandbox") ? sandboxItems : objects });
    }
    if (u.pathname === `/v2/locations/${P}`) return Response.json({ location });
    if (u.pathname === `/v2/locations/${S}`) return Response.json({ location: {} });
    if (u.pathname === "/v2/catalog/batch-upsert") {
      const objs = JSON.parse(init.body).batches[0].objects;
      const nested = objs.flatMap((o) => [o, ...(o.item_data?.variations ?? []), ...(o.modifier_list_data?.modifiers ?? [])]);
      return Response.json({ id_mappings: nested.map((o) => ({ client_object_id: o.id, object_id: "s" + o.id.slice(1) })) });
    }
    throw new Error("unexpected " + url);
  });
  return calls;
}
const quiet = () => {};

test("refuses to write anywhere but a sandbox", async () => {
  await assert.rejects(copyCatalog({ from, to: { ...to, SQUARE_ENV: "production" }, apply: true, log: quiet }), /must have SQUARE_ENV=sandbox/);
});

test("dry run reads production and writes nothing", async (t) => {
  const calls = mockSquare(t);
  const r = await copyCatalog({ from, to, log: quiet });
  assert.deepEqual(r, { applied: false });
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.ok(calls.filter((c) => !c.host.includes("sandbox")).every((c) => c.auth === "Bearer prod-token"));
});

test("refuses when the sandbox already has items, unless --force", async (t) => {
  mockSquare(t, { sandboxItems: [{ type: "ITEM", id: "X" }] });
  await assert.rejects(copyCatalog({ from, to, apply: true, log: quiet }), /already has 1 items/);
});

test("apply: updates the sandbox location, then upserts each phase with ids from earlier phases", async (t) => {
  const calls = mockSquare(t);
  const r = await copyCatalog({ from, to, apply: true, log: quiet });
  const writes = calls.filter((c) => c.method !== "GET");
  assert.ok(writes.every((c) => c.host === "connect.squareupsandbox.com" && c.auth === "Bearer sand-token"), "writes only to the sandbox");
  assert.equal(writes[0].path, `/v2/locations/${S}`);
  assert.equal(writes[0].body.location.timezone, "America/New_York");
  const upserts = writes.slice(1).map((c) => c.body.batches[0].objects);
  assert.equal(upserts.length, 5);
  assert.deepEqual(upserts[2][0].category_data.parent_category, { id: "sG_ROOT", ordinal: 3 });
  const item = upserts[4][0].item_data;
  assert.deepEqual(item.categories, [{ id: "sDON" }, { id: "sG_LDON", ordinal: 2 }]);
  assert.equal(item.modifier_list_info[0].modifier_overrides[0].modifier_id, "sM1");
  assert.deepEqual(r, { applied: true, copied: 8 }); // tax, 3 categories, list + modifier, item + variation
});
