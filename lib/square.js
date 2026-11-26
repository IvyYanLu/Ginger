// Square REST helpers shared by Pages Functions and scripts. No SDK, just fetch.

// One version for every request. See README ("Square API version").
export const SQUARE_VERSION = "2026-08-19";

export function baseUrl(env) {
  return env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

// fetch wrapper with auth headers. Throws an Error carrying Square's `errors`
// array (and the HTTP status) on non-2xx. Never includes the token in errors.
export async function sq(env, path, init = {}) {
  const res = await fetch(baseUrl(env) + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors = body.errors ?? [{ code: "HTTP_" + res.status, detail: res.statusText }];
    const err = new Error(
      `Square ${init.method ?? "GET"} ${path} -> ${res.status}: ` +
        errors.map((e) => `${e.code}${e.detail ? " (" + e.detail + ")" : ""}`).join("; ")
    );
    err.status = res.status;
    err.errors = errors;
    throw err;
  }
  return body;
}

// Present at a location: not deleted, and either present everywhere (default
// true) without being excluded, or explicitly listed.
export function isPresentAt(obj, locationId) {
  if (!obj || obj.is_deleted) return false;
  if (obj.present_at_location_ids?.includes(locationId)) return true;
  return (
    obj.present_at_all_locations !== false &&
    !(obj.absent_at_location_ids ?? []).includes(locationId)
  );
}

export const CATALOG_TYPES = "ITEM,CATEGORY,IMAGE,MODIFIER_LIST";

// Every catalog object of the given types, following the pagination cursor.
export async function listCatalog(env, types = CATALOG_TYPES) {
  const objects = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ types });
    if (cursor) qs.set("cursor", cursor);
    const page = await sq(env, `/v2/catalog/list?${qs}`);
    objects.push(...(page.objects ?? []));
    cursor = page.cursor;
  } while (cursor);
  return objects;
}

export async function getLocation(env) {
  const { location } = await sq(env, `/v2/locations/${encodeURIComponent(env.SQUARE_LOCATION_ID)}`);
  return location;
}

// ---------------------------------------------------------------------------
// Catalog -> online menu normalization

const csv = (s) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const lower = (s) => (s ?? "").toLowerCase();
const cents = (m) => (m && m.amount != null ? Number(m.amount) : null);
const byOrdinalThenName = (a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || a.name.localeCompare(b.name);

// Nested modifier lists on a modifier. `child_modifier_list_ids` is the field we
// know; the 2026-08-19 beta may name it differently, so catch any list-id array.
export function childLists(modData = {}) {
  const ids = new Set(modData.child_modifier_list_ids ?? []);
  for (const [k, v] of Object.entries(modData)) {
    if (/modifier_list/.test(k) && k !== "modifier_list_id" && Array.isArray(v) && v.length) {
      v.forEach((x) => ids.add(typeof x === "string" ? x : x?.modifier_list_id ?? JSON.stringify(x)));
    }
  }
  return [...ids];
}

// Selection limits for one item <-> modifier list link. max: Infinity = no limit.
export function effectiveLimits(info = {}, list = {}) {
  const im = info.min_selected_modifiers ?? -1;
  const iM = info.max_selected_modifiers ?? -1;
  if (im === -1 && iM === -1) {
    const lm = list.min_selected_modifiers;
    const lM = list.max_selected_modifiers;
    // Legacy lists predate min/max and only carry selection_type.
    if (lm == null && lM == null && list.selection_type === "SINGLE") return { min: 0, max: 1 };
    return { min: lm > 0 ? lm : 0, max: lM > 0 ? lM : Infinity };
  }
  // Item-level override. Item max 0 = no limit. INTERPRETATION (verify on the
  // POS): when only one of the two is set, the other -1 means "no requirement" /
  // "no limit" rather than "inherit from the list".
  return { min: im > 0 ? im : 0, max: iM > 0 ? iM : Infinity };
}

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_LABEL = { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" };

// "13:30:00" -> "1:30pm", "12:00" -> "12pm", "00:00" -> "12am"
export function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const h12 = h % 12 || 12;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}

// Square business_hours.periods -> "Mon Closed · Tue–Thu 11:30am–9:30pm · …"
export function formatHours(periods = []) {
  if (!periods.length) return "";
  const perDay = DAYS.map((d) => {
    const ps = periods
      .filter((p) => p.day_of_week === d)
      .sort((a, b) => a.start_local_time.localeCompare(b.start_local_time))
      .map((p) => `${formatTime(p.start_local_time)}–${formatTime(p.end_local_time)}`);
    return ps.length ? ps.join(", ") : "Closed";
  });
  const groups = [];
  perDay.forEach((hours, i) => {
    const g = groups.at(-1);
    if (g && g.hours === hours) g.end = i;
    else groups.push({ start: i, end: i, hours });
  });
  return groups
    .map(({ start, end, hours }) => {
      const days = start === end ? DAY_LABEL[DAYS[start]] : `${DAY_LABEL[DAYS[start]]}–${DAY_LABEL[DAYS[end]]}`;
      return `${days} ${hours}`;
    })
    .join(" · ");
}

export function restaurantInfo(location = {}) {
  const a = location.address ?? {};
  const region = [a.administrative_district_level_1, a.postal_code].filter(Boolean).join(" ");
  return {
    name: location.name ?? "",
    address: [a.address_line_1, a.address_line_2, a.locality, region].filter(Boolean).join(", "),
    phone: location.phone_number ?? "",
    hours: formatHours(location.business_hours?.periods),
  };
}

// CATEGORY_ORDER names first; "*" marks where all unlisted categories (A–Z) go.
// Without "*", unlisted categories go after the listed ones.
export function sortCategories(names, orderSetting) {
  const order = csv(orderSetting).map(lower);
  const star = order.includes("*") ? order.indexOf("*") : order.length;
  const rank = (n) => {
    const i = order.indexOf(lower(n));
    return i === -1 ? star : i;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const overrideAt = (overrides, locationId) => (overrides ?? []).find((o) => o.location_id === locationId) ?? {};

function normalizeVariation(v, locationId) {
  const d = v.item_variation_data ?? {};
  if (!isPresentAt(v, locationId) || d.pricing_type === "VARIABLE_PRICING") return null;
  const ov = overrideAt(d.location_overrides, locationId);
  const price = cents(ov.price_money) ?? cents(d.price_money);
  if (price == null) return null;
  return { id: v.id, label: d.name ?? "", price, soldOut: !!ov.sold_out, ordinal: d.ordinal };
}

// Returns a normalized list, null (skip the list), or { exclude: reason }.
function normalizeModifierList(info, listObj, locationId, hiddenLists) {
  const ld = listObj?.modifier_list_data;
  if (info.enabled === false || !ld || !isPresentAt(listObj, locationId)) return null;
  if (ld.modifier_type === "TEXT" || hiddenLists.has(lower(ld.name))) return null;

  let { min, max } = effectiveLimits(info, ld);
  const itemOv = new Map((info.modifier_overrides ?? []).map((o) => [o.modifier_id, o]));
  const mods = [];
  for (const m of ld.modifiers ?? []) {
    const md = m.modifier_data ?? {};
    const io = itemOv.get(m.id) ?? {};
    const locOv = overrideAt(md.location_overrides, locationId);
    const hidden = io.hidden_online ?? md.hidden_online;
    // Sold out at this location: treated like hidden (interpretation).
    if (!isPresentAt(m, locationId) || hidden || locOv.sold_out) continue;
    if (childLists(md).length) {
      if (min > 0) return { exclude: `modifier "${md.name}" in required list "${ld.name}" has nested lists` };
      continue; // optional list: drop just this modifier
    }
    mods.push({
      id: m.id,
      name: md.name ?? "",
      price: cents(locOv.price_money) ?? cents(md.price_money) ?? 0,
      on: !!(io.on_by_default ?? md.on_by_default),
      ordinal: md.ordinal,
    });
  }
  if (min > mods.length) return { exclude: `list "${ld.name}" requires ${min} but only ${mods.length} visible online` };
  if (!mods.length) return null;
  max = Math.min(max, mods.length);
  mods.sort(byOrdinalThenName);
  let defaults = 0;
  return {
    ordinal: info.ordinal,
    list: {
      id: listObj.id,
      name: ld.name,
      min,
      max: max === Infinity ? null : max,
      modifiers: mods.map(({ id, name, price, on }) => {
        const d = on && defaults < max;
        if (d) defaults++;
        return { id, name, price, default: d };
      }),
    },
  };
}

// Pure: catalog objects + location + env -> { menu, index }.
export function normalizeMenu(objects, location, env = {}) {
  const locationId = env.SQUARE_LOCATION_ID;
  const byId = new Map(objects.map((o) => [o.id, o]));
  const hiddenCats = new Set(csv(env.HIDE_CATEGORIES).map(lower));
  const hiddenLists = new Set(csv(env.HIDE_MODIFIER_LISTS).map(lower));
  const catName = (id) => {
    const c = byId.get(id);
    return c && !c.is_deleted ? c.category_data?.name : undefined;
  };

  const groups = new Map(); // category name -> [{ item, ordinal }]
  const index = {};
  for (const obj of objects) {
    if (obj.type !== "ITEM") continue;
    const d = obj.item_data ?? {};
    if (d.is_archived || d.ecom_visibility === "HIDDEN" || d.ecom_visibility === "UNAVAILABLE") continue;
    if (!isPresentAt(obj, locationId)) continue;

    const catId = d.reporting_category?.id ?? d.categories?.[0]?.id ?? d.category_id;
    const category = catName(catId) ?? "Other";
    // Hide if ANY of the item's categories is hidden (an item can be in both
    // "Sake" and "Drinks"); stricter than the primary category alone.
    const allCats = [d.reporting_category?.id, ...(d.categories ?? []).map((c) => c.id), d.category_id];
    if (allCats.some((id) => id && hiddenCats.has(lower(catName(id))))) continue;

    const variations = (d.variations ?? [])
      .map((v) => normalizeVariation(v, locationId))
      .filter(Boolean)
      .sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity))
      .map(({ ordinal, ...v }) => v);
    if (!variations.length) continue;

    const lists = [];
    let excluded;
    for (const info of d.modifier_list_info ?? []) {
      const r = normalizeModifierList(info, byId.get(info.modifier_list_id), locationId, hiddenLists);
      if (!r) continue;
      if (r.exclude) { excluded = r.exclude; break; }
      lists.push(r);
    }
    if (excluded) {
      console.warn(`menu: excluding "${d.name}" (${obj.id}): ${excluded}`);
      continue;
    }
    lists.sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || a.list.name.localeCompare(b.list.name));

    const image = byId.get(d.image_ids?.[0])?.image_data?.url ?? null;
    const item = {
      id: obj.id,
      name: d.name ?? "",
      desc: d.description_plaintext ?? d.description ?? "",
      image,
      variations,
      modifierLists: lists.map((l) => l.list),
    };
    const ord = [d.reporting_category, ...(d.categories ?? [])].find((c) => c?.id === catId)?.ordinal;
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push({ item, ordinal: ord, name: item.name });
    for (const v of variations) index[v.id] = item;
  }

  const categories = sortCategories([...groups.keys()], env.CATEGORY_ORDER).map((name) => ({
    name,
    items: groups.get(name).sort(byOrdinalThenName).map((g) => g.item),
  }));
  return { menu: { restaurant: restaurantInfo(location), categories }, index };
}

// 60 s per-isolate cache. Keyed on the settings that change the output.
let cache = null;
const CACHE_MS = 60_000;
export function resetMenuCache() { cache = null; }

export async function getMenu(env) {
  const key = [env.SQUARE_ENV, env.SQUARE_LOCATION_ID, env.HIDE_CATEGORIES, env.HIDE_MODIFIER_LISTS, env.CATEGORY_ORDER].join("|");
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [objects, location] = await Promise.all([listCatalog(env), getLocation(env)]);
  const value = { ...normalizeMenu(objects, location, env), location };
  cache = { key, at: Date.now(), value };
  return value;
}
