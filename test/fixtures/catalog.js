// Shared Square catalog fixture (unit, function and e2e tests). Location LOC1.
const usd = (amount) => ({ amount, currency: "USD" });
const cat = (id, name) => ({ type: "CATEGORY", id, category_data: { name } });
const vari = (id, name, price, extra = {}, data = {}) => ({
  type: "ITEM_VARIATION", id, ...extra,
  item_variation_data: { name, pricing_type: "FIXED_PRICING", price_money: usd(price), ...data },
});
const mod = (id, name, price, data = {}, extra = {}) => ({
  type: "MODIFIER", id, ...extra, modifier_data: { name, ...(price != null && { price_money: usd(price) }), ...data },
});
const item = (id, name, catId, variations, data = {}, extra = {}) => ({
  type: "ITEM", id, ...extra,
  item_data: { name, ecom_visibility: "VISIBLE", reporting_category: { id: catId }, categories: [{ id: catId }], variations, ...data },
});
const list = (id, name, modifiers, data = {}) => ({ type: "MODIFIER_LIST", id, modifier_list_data: { name, modifiers, ...data } });

export const location = {
  id: "LOC1", name: "Ginger Japanese Restaurant", timezone: "America/New_York",
  address: { address_line_1: "1 Main St", locality: "Bedford", administrative_district_level_1: "MA", postal_code: "01730" },
  phone_number: "+17815550100",
  business_hours: { periods: [
    ...["MON", "TUE", "WED", "THU", "FRI"].flatMap((d) => [
      { day_of_week: d, start_local_time: "11:00:00", end_local_time: "14:30:00" },
      { day_of_week: d, start_local_time: "16:00:00", end_local_time: "21:30:00" },
    ]),
    { day_of_week: "SAT", start_local_time: "11:00:00", end_local_time: "22:00:00" },
    { day_of_week: "SUN", start_local_time: "12:00:00", end_local_time: "22:00:00" },
  ] },
};

export const objects = [
  cat("C_APP", "Appetizers"), cat("C_MAKI", "Maki"), cat("C_ENT", "Entrées"),
  cat("C_DES", "Desserts"), cat("C_DRK", "Drinks"), cat("C_SAKE", "Sake"),
  { type: "IMAGE", id: "IMG1", image_data: { url: "https://img.example/edamame.jpg" } },

  list("ML_RICE", "Rice", [
    mod("M_WHITE", "White rice", 0, { ordinal: 1, on_by_default: true }),
    mod("M_BROWN", "Brown rice", 100, { ordinal: 2 }),
  ], { min_selected_modifiers: 1, max_selected_modifiers: 1, selection_type: "SINGLE" }),
  list("ML_TOP", "Toppings", [
    mod("M_SPICY", "Spicy mayo", 50, { ordinal: 2, on_by_default: true }),
    mod("M_EEL", "Eel sauce", 50, { ordinal: 1, on_by_default: true }),
    mod("M_TOBIKO", "Tobiko", 150, { ordinal: 3, location_overrides: [{ location_id: "LOC1", price_money: usd(200) }] }),
    mod("M_HIDDEN", "Staff topping", 0, { ordinal: 4, hidden_online: true }),
    mod("M_NEST", "Combo sauce", 0, { ordinal: 5, child_modifier_list_ids: ["ML_RICE"] }),
  ], { min_selected_modifiers: 0, max_selected_modifiers: 2 }),
  list("ML_RUSH", "Rush", [mod("M_RUSH", "Rush", 0)]),
  list("ML_NOTE", "Note", [], { modifier_type: "TEXT" }),
  list("ML_ONLYHIDDEN", "Sauce", [mod("M_SAUCE", "House", 0, { hidden_online: true })], { min_selected_modifiers: 1, max_selected_modifiers: 1 }),
  list("ML_LEGACY", "Size", [mod("M_S", "Small", 0, { ordinal: 1 }), mod("M_L", "Large", 200, { ordinal: 2 })], { selection_type: "SINGLE" }),
  list("ML_REQNEST", "Base", [mod("M_BASE", "Base", 0, { child_modifier_list_ids: ["ML_TOP"] })], { min_selected_modifiers: 1, max_selected_modifiers: 1 }),

  item("I_EDA", "Edamame", "C_APP", [vari("V_EDA", "Regular", 600)],
    { description_plaintext: "Steamed soybeans, sea salt", image_ids: ["IMG1"] }),
  item("I_GYO", "Gyoza", "C_APP", [vari("V_GYO", "Regular", 800, {}, { location_overrides: [{ location_id: "LOC1", price_money: usd(850) }] })],
    { description: "<p>Pork dumplings</p>" }),
  item("I_CAL", "California Roll", "C_MAKI", [
    vari("V_CAL_8", "8 pc", 900, {}, { ordinal: 2 }),
    vari("V_CAL_4", "4 pc", 500, {}, { ordinal: 1, location_overrides: [{ location_id: "LOC1", sold_out: true }] }),
  ], { modifier_list_info: [
    { modifier_list_id: "ML_TOP", ordinal: 2 },
    { modifier_list_id: "ML_RICE", ordinal: 1, min_selected_modifiers: -1, max_selected_modifiers: -1 },
    { modifier_list_id: "ML_RUSH", ordinal: 3 },
    { modifier_list_id: "ML_NOTE", ordinal: 4 },
  ] }),
  item("I_TERI", "Chicken Teriyaki", "C_ENT", [vari("V_TERI", "Regular", 1800)], { modifier_list_info: [
    { modifier_list_id: "ML_TOP", modifier_overrides: [{ modifier_id: "M_SPICY", on_by_default: false }, { modifier_id: "M_HIDDEN", hidden_online: false }] },
    { modifier_list_id: "ML_LEGACY", enabled: false },
  ] }),
  item("I_RAMEN", "Ramen", "C_ENT", [vari("V_RAMEN", "Regular", 1500)], { modifier_list_info: [{ modifier_list_id: "ML_LEGACY" }] }),
  item("I_MOCHI", "Mochi", "C_DES", [vari("V_MOCHI", "Regular", 700)]),
  item("I_TEA", "Green Tea", "C_DRK", [vari("V_TEA", "Hot", 300)]),
  item("I_NOCAT", "Mystery Special", undefined, [vari("V_NOCAT", "Regular", 1200)], { reporting_category: undefined, categories: undefined }),

  // Excluded items
  item("I_SAKE", "House Sake", "C_SAKE", [vari("V_SAKE", "Carafe", 1400)]),
  item("I_SAKE2", "Sake Flight", "C_DRK", [vari("V_SAKE2", "Flight", 1600)], { categories: [{ id: "C_DRK" }, { id: "C_SAKE" }] }),
  item("I_ARCH", "Old Roll", "C_MAKI", [vari("V_ARCH", "Regular", 900)], { is_archived: true }),
  item("I_HID", "Secret Roll", "C_MAKI", [vari("V_HID", "Regular", 900)], { ecom_visibility: "HIDDEN" }),
  item("I_UNAV", "Unavailable Roll", "C_MAKI", [vari("V_UNAV", "Regular", 900)], { ecom_visibility: "UNAVAILABLE" }),
  item("I_MKT", "Market Fish", "C_ENT", [{ type: "ITEM_VARIATION", id: "V_MKT", item_variation_data: { name: "Regular", pricing_type: "VARIABLE_PRICING" } }]),
  item("I_NOPRICE", "No Price", "C_ENT", [{ type: "ITEM_VARIATION", id: "V_NP", item_variation_data: { name: "Regular", pricing_type: "FIXED_PRICING" } }]),
  item("I_OTHERLOC", "Other Shop Roll", "C_MAKI", [vari("V_OL", "Regular", 900)], {}, { present_at_all_locations: false, present_at_location_ids: ["LOC2"] }),
  item("I_ABSENT", "Absent Roll", "C_MAKI", [vari("V_AB", "Regular", 900)], {}, { absent_at_location_ids: ["LOC1"] }),
  item("I_DELETED", "Deleted Roll", "C_MAKI", [vari("V_DEL", "Regular", 900)], {}, { is_deleted: true }),
  item("I_VARGONE", "Var Absent", "C_MAKI", [vari("V_VG", "Regular", 900, { absent_at_location_ids: ["LOC1"] })]),
  item("I_IMPOSSIBLE", "Saucy Roll", "C_MAKI", [vari("V_IMP", "Regular", 900)], { modifier_list_info: [{ modifier_list_id: "ML_ONLYHIDDEN" }] }),
  item("I_REQNEST", "Build Bowl", "C_ENT", [vari("V_RN", "Regular", 1300)], { modifier_list_info: [{ modifier_list_id: "ML_REQNEST" }] }),
  // Only present at this location explicitly
  item("I_HERE", "Bedford Roll", "C_MAKI", [vari("V_HERE", "Regular", 1000)], {}, { present_at_all_locations: false, present_at_location_ids: ["LOC1"] }),
];

export const env = {
  SQUARE_ACCESS_TOKEN: "test-token", SQUARE_LOCATION_ID: "LOC1", SQUARE_ENV: "sandbox",
  SITE_URL: "https://order.example", HIDE_CATEGORIES: "Cocktails, wine,SAKE,Beer",
  HIDE_MODIFIER_LISTS: "rush,Comp", CATEGORY_ORDER: "Appetizers,*,Desserts,Drinks", PREP_TIME: "PT20M",
};
