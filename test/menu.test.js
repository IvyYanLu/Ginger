import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { plainText, effectiveLimits, normalizeMenu, formatHours, formatTime, sortCategories, isPresentAt, restaurantInfo } from "../lib/square.js";
import { objects, location, env } from "./fixtures/catalog.js";

describe("effectiveLimits", () => {
  const L = (min, max, selection_type) => ({ min_selected_modifiers: min, max_selected_modifiers: max, selection_type });
  const I = (min, max) => ({ min_selected_modifiers: min, max_selected_modifiers: max });
  const cases = [
    // [item min, item max, list min, list max, expected]
    [-1, -1, 1, 3, { min: 1, max: 3 }],
    [-1, -1, 0, 0, { min: 0, max: Infinity }],
    [-1, -1, -1, -1, { min: 0, max: Infinity }],
    [-1, -1, 2, -1, { min: 2, max: Infinity }],
    [-1, -1, -1, 2, { min: 0, max: 2 }],
    [-1, -1, 0, 1, { min: 0, max: 1 }],
    [1, 1, 0, 5, { min: 1, max: 1 }],
    [2, 0, 0, 1, { min: 2, max: Infinity }],   // item max 0 = no limit
    [0, 0, 1, 1, { min: 0, max: Infinity }],   // item override wins over list
    [0, 3, 2, 2, { min: 0, max: 3 }],
    [2, -1, 0, 1, { min: 2, max: Infinity }],  // only min set: -1 max = no limit
    [-1, 2, 1, 1, { min: 0, max: 2 }],         // only max set: -1 min = none required
  ];
  for (const [im, iM, lm, lM, want] of cases) {
    test(`item ${im}/${iM} list ${lm}/${lM}`, () => assert.deepEqual(effectiveLimits(I(im, iM), L(lm, lM)), want));
  }
  test("missing item limits default to -1", () => assert.deepEqual(effectiveLimits({}, L(1, 2)), { min: 1, max: 2 }));
  test("legacy SINGLE with no min/max -> exactly one", () => assert.deepEqual(effectiveLimits({}, { selection_type: "SINGLE" }), { min: 1, max: 1 }));
  test("SINGLE with explicit min 0 stays optional", () => assert.deepEqual(effectiveLimits({}, L(0, undefined, "SINGLE")), { min: 0, max: Infinity }));
  test("SINGLE with -1/-1 list limits -> exactly one", () => assert.deepEqual(effectiveLimits({}, L(-1, -1, "SINGLE")), { min: 1, max: 1 }));
  test("legacy MULTIPLE with no min/max -> no limit", () => assert.deepEqual(effectiveLimits({}, { selection_type: "MULTIPLE" }), { min: 0, max: Infinity }));
  test("SINGLE with explicit limits uses them", () => assert.deepEqual(effectiveLimits({}, L(1, 1, "SINGLE")), { min: 1, max: 1 }));
});

describe("isPresentAt", () => {
  test("defaults to present everywhere", () => assert.ok(isPresentAt({}, "L")));
  test("absent list", () => assert.ok(!isPresentAt({ absent_at_location_ids: ["L"] }, "L")));
  test("explicit list only", () => {
    assert.ok(isPresentAt({ present_at_all_locations: false, present_at_location_ids: ["L"] }, "L"));
    assert.ok(!isPresentAt({ present_at_all_locations: false, present_at_location_ids: ["X"] }, "L"));
    assert.ok(!isPresentAt({ present_at_all_locations: false }, "L"));
  });
  test("deleted", () => assert.ok(!isPresentAt({ is_deleted: true }, "L")));
});

describe("normalizeMenu", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  const { menu, index } = normalizeMenu(objects, location, env);
  console.warn = origWarn;
  const all = menu.categories.flatMap((c) => c.items);
  const find = (name) => all.find((i) => i.name === name);

  test("category order: listed, then A–Z, then the tail after *", () => {
    assert.deepEqual(menu.categories.map((c) => c.name), ["Appetizers", "Entrées", "Maki", "Other", "Desserts", "Drinks"]);
  });
  test("excluded items", () => {
    for (const n of ["House Sake", "Sake Flight", "Old Roll", "Secret Roll", "Unavailable Roll", "Market Fish", "No Price",
      "Other Shop Roll", "Absent Roll", "Deleted Roll", "Var Absent", "Saucy Roll", "Build Bowl"]) {
      assert.equal(find(n), undefined, n);
    }
    assert.ok(find("Bedford Roll"), "explicitly present at location");
  });
  test("warns why impossible items are excluded", () => {
    assert.ok(warnings.some((w) => /Saucy Roll.*requires 1 but only 0/.test(w)), warnings.join("\n"));
    assert.ok(warnings.some((w) => /Build Bowl.*nested/.test(w)), warnings.join("\n"));
  });
  test("uncategorized items go under Other", () => assert.equal(menu.categories.find((c) => c.name === "Other").items[0].name, "Mystery Special"));
  test("description, image", () => {
    assert.deepEqual(find("Edamame"), {
      id: "I_EDA", name: "Edamame", desc: "Steamed soybeans, sea salt", image: "https://img.example/edamame.jpg",
      variations: [{ id: "V_EDA", label: "Regular", price: 600, soldOut: false }], modifierLists: [],
    });
    assert.equal(find("Gyoza").desc, "Pork dumplings"); // HTML description reduced to text
    assert.equal(find("Gyoza").image, null);
  });
  test("variation price override, sold out, ordinal sort", () => {
    assert.equal(find("Gyoza").variations[0].price, 850);
    assert.deepEqual(find("California Roll").variations, [
      { id: "V_CAL_4", label: "4 pc", price: 500, soldOut: true },
      { id: "V_CAL_8", label: "8 pc", price: 900, soldOut: false },
    ]);
  });
  test("modifier lists: sorted, hidden/TEXT skipped, nested dropped, defaults capped", () => {
    assert.deepEqual(find("California Roll").modifierLists, [
      { id: "ML_RICE", name: "Rice", min: 1, max: 1, modifiers: [
        { id: "M_WHITE", name: "White rice", price: 0, default: true },
        { id: "M_BROWN", name: "Brown rice", price: 100, default: false },
      ] },
      { id: "ML_TOP", name: "Toppings", min: 0, max: 2, modifiers: [
        { id: "M_EEL", name: "Eel sauce", price: 50, default: true },
        { id: "M_SPICY", name: "Spicy mayo", price: 50, default: true },
        { id: "M_TOBIKO", name: "Tobiko", price: 200, default: false },
      ] },
    ]);
  });
  test("per-item modifier overrides, disabled list", () => {
    const top = find("Chicken Teriyaki").modifierLists;
    assert.equal(top.length, 1);
    assert.deepEqual(top[0].modifiers.map((m) => [m.id, m.default]), [["M_EEL", true], ["M_SPICY", false], ["M_TOBIKO", false], ["M_HIDDEN", false]]);
    assert.equal(top[0].max, 2);
  });
  test("defaults capped at max in ordinal order", () => {
    const objs = objects.map((o) => o.id === "ML_TOP"
      ? { ...o, modifier_list_data: { ...o.modifier_list_data, max_selected_modifiers: 1 } } : o);
    const roll = normalizeMenu(objs, location, env).menu.categories.flatMap((c) => c.items).find((i) => i.id === "I_CAL");
    assert.deepEqual(roll.modifierLists[1].modifiers.map((m) => m.default), [true, false, false]);
  });
  test("legacy SINGLE list requires exactly 1; max lowered to visible count", () => {
    assert.deepEqual(find("Ramen").modifierLists[0], { id: "ML_LEGACY", name: "Size", min: 1, max: 1, modifiers: [
      { id: "M_S", name: "Small", price: 0, default: false }, { id: "M_L", name: "Large", price: 200, default: false },
    ] });
    const objs = objects.map((o) => o.id === "ML_LEGACY" ? { ...o, modifier_list_data: { ...o.modifier_list_data, selection_type: "MULTIPLE" } } : o);
    const ramen = normalizeMenu(objs, location, env).menu.categories.flatMap((c) => c.items).find((i) => i.id === "I_RAMEN");
    assert.equal(ramen.modifierLists[0].max, 2);
  });
  test("HIDE_MODIFIER_LISTS is case-insensitive", () => {
    assert.ok(!find("California Roll").modifierLists.some((l) => l.name === "Rush"));
    const shown = normalizeMenu(objects, location, { ...env, HIDE_MODIFIER_LISTS: "" }).index.V_CAL_8.modifierLists;
    assert.ok(shown.some((l) => l.name === "Rush"));
  });
  test("index maps every variation to its item", () => {
    assert.equal(index.V_CAL_4.id, "I_CAL");
    assert.equal(index.V_CAL_8, index.V_CAL_4);
    assert.equal(index.V_SAKE, undefined);
  });
  test("items within a category: ordinal, then name", () => {
    const objs = objects.map((o) => o.id === "I_GYO" ? { ...o, item_data: { ...o.item_data, categories: [{ id: "C_APP", ordinal: 1 }], reporting_category: { id: "C_APP", ordinal: 1 } } } : o);
    const apps = normalizeMenu(objs, location, env).menu.categories[0].items.map((i) => i.name);
    assert.deepEqual(apps, ["Gyoza", "Edamame"]);
    assert.deepEqual(menu.categories[0].items.map((i) => i.name), ["Edamame", "Gyoza"]);
  });
  test("restaurant info", () => {
    assert.deepEqual(menu.restaurant, {
      name: "Ginger Japanese Restaurant", address: "1 Main St, Bedford, MA 01730", phone: "+17815550100",
      hours: "Mon–Thu 11am–2:30pm, 4pm–9:30pm · Fri 11am–2:30pm, 4pm–10pm · Sat 11am–10pm · Sun 12pm–9:30pm",
      hoursTable: [
        { days: ["MON", "TUE", "WED", "THU"], label: "Mon–Thu", times: ["11am – 2:30pm", "4pm – 9:30pm"] },
        { days: ["FRI"], label: "Fri", times: ["11am – 2:30pm", "4pm – 10pm"] },
        { days: ["SAT"], label: "Sat", times: ["11am – 10pm"] },
        { days: ["SUN"], label: "Sun", times: ["12pm – 9:30pm"] },
      ],
    });
    assert.deepEqual(restaurantInfo({}), { name: "", address: "", phone: "", hours: "", hoursTable: [] });
  });
});

describe("sortCategories", () => {
  test("no setting: A–Z", () => assert.deepEqual(sortCategories(["b", "A", "c"], ""), ["A", "b", "c"]));
  test("no *: unlisted go after", () => assert.deepEqual(sortCategories(["Maki", "Drinks", "Apps", "Zen"], "drinks,Apps"), ["Drinks", "Apps", "Maki", "Zen"]));
  test("listed but absent names are ignored", () => assert.deepEqual(sortCategories(["X"], "Nope,*,Gone"), ["X"]));
});

describe("hours", () => {
  const p = (day_of_week, s, e) => ({ day_of_week, start_local_time: s, end_local_time: e });
  test("formatTime: noon, midnight, minutes", () => {
    assert.equal(formatTime("12:00:00"), "12pm");
    assert.equal(formatTime("00:00"), "12am");
    assert.equal(formatTime("11:30:00"), "11:30am");
    assert.equal(formatTime("21:05"), "9:05pm");
  });
  test("groups consecutive days, shows closed days", () => {
    const periods = [
      ...["TUE", "WED", "THU"].map((d) => p(d, "11:30:00", "21:30:00")),
      p("FRI", "11:30:00", "22:30:00"), p("SAT", "11:30:00", "22:30:00"), p("SUN", "12:00:00", "21:30:00"),
    ];
    assert.equal(formatHours(periods), "Mon Closed · Tue–Thu 11:30am–9:30pm · Fri–Sat 11:30am–10:30pm · Sun 12pm–9:30pm");
  });
  test("non-consecutive identical days are not merged; midnight close", () => {
    assert.equal(formatHours([p("MON", "12:00", "00:00"), p("WED", "12:00", "00:00")]),
      "Mon 12pm–12am · Tue Closed · Wed 12pm–12am · Thu–Sun Closed");
  });
  test("split periods sorted by start", () => {
    assert.equal(formatHours(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].flatMap((d) => [p(d, "17:00", "21:00"), p(d, "11:00", "14:00")])),
      "Mon–Sun 11am–2pm, 5pm–9pm");
  });
  test("no hours -> empty", () => assert.equal(formatHours(), ""));
});

test("plainText", () => {
  assert.equal(plainText("<p>Tuna &amp; salmon</p><p>Spicy&nbsp;mayo</p>"), "Tuna & salmon\nSpicy mayo");
  assert.equal(plainText("a <b>bold</b> &lt;b&gt;"), "a bold <b>");
  assert.equal(plainText(undefined), "");
});

describe("POS-only rows", () => {
  const usd = (amount) => ({ amount, currency: "USD" });
  const objs = [
    { type: "CATEGORY", id: "C1", category_data: { name: "Maki" } },
    { type: "MODIFIER_LIST", id: "ML1", modifier_list_data: { name: "Maki Add-ons", min_selected_modifiers: 0, max_selected_modifiers: 0, modifiers: [
      { type: "MODIFIER", id: "M1", modifier_data: { name: "Avocado", price_money: usd(150), ordinal: 1 } },
      { type: "MODIFIER", id: "M2", modifier_data: { name: "---------", ordinal: 2 } },
      { type: "MODIFIER", id: "M3", modifier_data: { name: "$1 Key", price_money: usd(100), ordinal: 3 } },
      { type: "MODIFIER", id: "M4", modifier_data: { name: "$1.5 key", price_money: usd(150), ordinal: 4 } },
    ] } },
    { type: "MODIFIER_LIST", id: "ML2", modifier_list_data: { name: "Special Instructions", modifier_type: "TEXT", min_selected_modifiers: 1, max_selected_modifiers: 1 } },
    ...["Tuna Maki", "----------------------------------------------", "//////////"].map((name, i) => ({
      type: "ITEM", id: "I" + i, item_data: { name, reporting_category: { id: "C1" },
        variations: [{ type: "ITEM_VARIATION", id: "V" + i, item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING", price_money: usd(800) } }],
        modifier_list_info: [{ modifier_list_id: "ML2", ordinal: 1 }, { modifier_list_id: "ML1", ordinal: 2 }] },
    })),
  ];
  const { menu } = normalizeMenu(objs, {}, { HIDE_MODIFIERS: "$1 Key, $1.5 Key" });

  test("separator items are hidden", () => assert.deepEqual(menu.categories[0].items.map((i) => i.name), ["Tuna Maki"]));
  test("separator modifiers and HIDE_MODIFIERS (case-insensitive) are hidden; a required TEXT list doesn't hide the item", () => {
    const [l] = menu.categories[0].items[0].modifierLists;
    assert.equal(l.name, "Maki Add-ons");
    assert.deepEqual(l.modifiers.map((m) => m.name), ["Avocado"]);
  });
});

describe("lunch-only items", () => {
  const usd = (amount) => ({ amount, currency: "USD" });
  const cat = (id, name, parent) => ({ type: "CATEGORY", id, category_data: { name, ...(parent && { parent_category: { id: parent } }) } });
  const item = (id, name, cats) => ({ type: "ITEM", id, item_data: { name, reporting_category: { id: cats[0] }, categories: cats.map((c) => ({ id: c })),
    variations: [{ type: "ITEM_VARIATION", id: "V" + id, item_variation_data: { name: "", pricing_type: "FIXED_PRICING", price_money: usd(1500) } }] } });
  const objs = [
    cat("ROOT", "Ginger Japanese Menu"),
    cat("DON", "Don Buri"),                         // reporting category, no parent
    cat("G_DON", "Don Buri", "ROOT"),               // POS menu group
    cat("G_LDON", "Lunch Don & Udon", "ROOT"),
    cat("G_NOODLE", "Udon, Soba & Ramen", "ROOT"),
    cat("NOODLE", "Udon / Soba / Ramen"),
    cat("BOX", "Lunch Boxes"),
    cat("KITCHEN", "General Kitchen Foods"),        // printer routing, no parent
    item("GYUDON", "Gyudon", ["DON", "G_LDON", "KITCHEN"]),
    item("GYUDONBURI", "Gyu Donburi", ["DON", "G_DON", "KITCHEN"]),
    item("YAKISOBA", "Yaki Soba", ["NOODLE", "G_NOODLE", "G_LDON", "KITCHEN"]),
    item("BENTO", "Chicken Katsu Lunch Box", ["BOX", "KITCHEN"]),
  ];
  const lunchEnv = { LUNCH_HOURS: "MON-SUN 11:00-14:30", LUNCH_ONLY_CATEGORIES: "Lunch Boxes, lunch don & udon" };
  const flags = (e) => Object.fromEntries(normalizeMenu(objs, {}, e).menu.categories.flatMap((c) => c.items).map((i) => [i.name, !!i.lunchOnly]));

  test("lunch-only = in a lunch category and in no other menu group", () => {
    assert.deepEqual(flags(lunchEnv), { Gyudon: true, "Gyu Donburi": false, "Yaki Soba": false, "Chicken Katsu Lunch Box": true });
  });
  test("lunch-only items are listed under their lunch category", () => {
    const sections = Object.fromEntries(normalizeMenu(objs, {}, lunchEnv).menu.categories.map((c) => [c.name, c.items.map((i) => i.name)]));
    assert.deepEqual(sections, {
      "Don Buri": ["Gyu Donburi"],
      "Lunch Boxes": ["Chicken Katsu Lunch Box"],
      "Lunch Don & Udon": ["Gyudon"],
      "Udon / Soba / Ramen": ["Yaki Soba"],
    });
  });
  test("lunch sections are flagged for the Lunch group", () => {
    const cats = normalizeMenu(objs, {}, lunchEnv).menu.categories;
    assert.deepEqual(cats.filter((c) => c.lunch).map((c) => c.name).sort(), ["Lunch Boxes", "Lunch Don & Udon"]);
  });
  test("needs LUNCH_HOURS too, or nothing is lunch-only", () => {
    assert.deepEqual(flags({ LUNCH_ONLY_CATEGORIES: lunchEnv.LUNCH_ONLY_CATEGORIES }), { Gyudon: false, "Gyu Donburi": false, "Yaki Soba": false, "Chicken Katsu Lunch Box": false });
  });
});
