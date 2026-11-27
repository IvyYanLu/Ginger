#!/usr/bin/env node
// Discovery: prints the restaurant's Square catalog structure as a readable report.
// Usage: node scripts/dump-catalog.mjs   (reads env vars, falling back to .dev.vars)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listCatalog, getLocation, isPresentAt, childLists, isSeparator, normalizeMenu } from "../lib/square.js";

// Minimal KEY=value parser for .dev.vars (quotes optional, # comments).
export function parseDevVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function loadEnv() {
  let file = {};
  try {
    file = parseDevVars(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"));
  } catch {}
  const env = { ...file, ...process.env };
  for (const k of ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"]) {
    if (!env[k]) throw new Error(`Missing ${k} (set it in the environment or .dev.vars)`);
  }
  return env;
}

const money = (m) => (m ? `$${(Number(m.amount) / 100).toFixed(2)}${m.currency && m.currency !== "USD" ? " " + m.currency : ""}` : "—");
const flag = (cond, label) => (cond ? ` [${label}]` : "");

const fmtTime = (t) => (t ?? "").slice(0, 5);

// Name key that a lunch item and its all-day version share:
// "Gyudon" / "Gyu Donburi", "Chicken Teriyaki Lunch Box" / "Chicken Teriyaki D",
// "Sashimi Lunch" / "Sashimi Dinner", "Nabe Yaki Udon" / "Nabeyaki Udon".
const PAIR_DROP = new Set(["lunch", "dinner", "box", "d"]);
export function pairKey(name) {
  const words = (name ?? "").toLowerCase().split(/[^a-z0-9&]+/);
  return words.filter((w) => w && !PAIR_DROP.has(w)).join("").replace(/buri$/, "");
}
const dollars = (c) => `$${(c / 100).toFixed(2)}`;
const minPrice = (it) => Math.min(...it.variations.map((v) => v.price));
const priceRange = (it) => {
  const ps = it.variations.map((v) => v.price);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  return lo === hi ? dollars(lo) : `${dollars(lo)}–${dollars(hi)}`;
};

export function buildReport(objects, location, locationId, env = {}) {
  const L = [];
  const warn = [];
  const byType = (t) => objects.filter((o) => o.type === t);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const name = (id) => byId.get(id)?.category_data?.name ?? byId.get(id)?.modifier_list_data?.name ?? `?${id}`;
  const here = (o) => (isPresentAt(o, locationId) ? "" : " [NOT AT LOCATION]");
  const items = byType("ITEM");
  const lists = byType("MODIFIER_LIST");

  // --- Location
  L.push("=== LOCATION ===");
  if (location) {
    const a = location.address ?? {};
    L.push(`Name:     ${location.name}${location.business_name ? ` (business: ${location.business_name})` : ""}`);
    L.push(`ID:       ${location.id}   status: ${location.status}   timezone: ${location.timezone}`);
    L.push(`Address:  ${[a.address_line_1, a.address_line_2, a.locality, a.administrative_district_level_1, a.postal_code].filter(Boolean).join(", ")}`);
    L.push(`Phone:    ${location.phone_number ?? "—"}`);
    const periods = location.business_hours?.periods ?? [];
    L.push(`Hours:    ${periods.length ? "" : "— (none set)"}`);
    for (const p of periods) L.push(`  ${p.day_of_week}  ${fmtTime(p.start_local_time)}–${fmtTime(p.end_local_time)}`);
    if (!periods.length) warn.push("Location has no business hours: scheduled pickup needs them.");
  }

  // --- Categories
  const catOf = (it) => it.item_data?.reporting_category?.id ?? it.item_data?.categories?.[0]?.id ?? it.item_data?.category_id;
  const counts = new Map();
  for (const it of items) {
    const c = catOf(it);
    counts.set(c ?? "(none)", (counts.get(c ?? "(none)") ?? 0) + 1);
  }
  L.push("", `=== CATEGORIES (${byType("CATEGORY").length}) ===`);
  for (const c of byType("CATEGORY").sort((a, b) => a.category_data.name.localeCompare(b.category_data.name))) {
    L.push(`  ${c.category_data.name.padEnd(32)} ${String(counts.get(c.id) ?? 0).padStart(3)} items${here(c)}${flag(c.category_data.parent_category?.id, "parent: " + name(c.category_data.parent_category?.id))}`);
  }
  if (counts.get("(none)")) L.push(`  ${"(no category)".padEnd(32)} ${String(counts.get("(none)")).padStart(3)} items`);

  // --- Items
  const usedBy = new Map(); // listId -> [item names]
  L.push("", `=== ITEMS (${items.length}) ===`);
  for (const it of items.sort((a, b) => (a.item_data.name ?? "").localeCompare(b.item_data.name ?? ""))) {
    const d = it.item_data;
    const cats = [
      d.reporting_category && `reporting: ${name(d.reporting_category.id)}`,
      d.categories?.length && `categories: ${d.categories.map((c) => name(c.id)).join(", ")}`,
      d.category_id && `category_id: ${name(d.category_id)}`,
    ].filter(Boolean);
    L.push("", `• ${d.name}  (${it.id})${here(it)}${flag(d.is_archived, "ARCHIVED")}`);
    L.push(`    ecom_visibility: ${d.ecom_visibility ?? "—"}   images: ${d.image_ids?.length ?? 0}   ${cats.join(" · ") || "NO CATEGORY"}`);
    if (isSeparator(d.name)) { L.push("    (separator row: hidden online)"); continue; }
    if (!cats.length) warn.push(`Item "${d.name}" has no category (will show under "Other").`);
    for (const v of d.variations ?? []) {
      const vd = v.item_variation_data;
      const ov = (vd.location_overrides ?? []).filter((o) => o.location_id === locationId);
      const ovs = ov.map((o) => [o.price_money && `price ${money(o.price_money)}`, o.sold_out && "SOLD OUT", o.track_inventory && "tracked"].filter(Boolean).join(", ")).filter(Boolean);
      L.push(`    - ${(vd.name ?? "").padEnd(24)} ${money(vd.price_money).padStart(8)}  ${vd.pricing_type}${ovs.length ? "  override: " + ovs.join("; ") : ""}${here(v)}`);
      if (vd.pricing_type === "VARIABLE_PRICING") warn.push(`"${d.name} / ${vd.name}" is variable-priced (not orderable online).`);
    }
    for (const info of d.modifier_list_info ?? []) {
      const lst = byId.get(info.modifier_list_id);
      const lname = lst?.modifier_list_data?.name ?? `MISSING ${info.modifier_list_id}`;
      if (lst) usedBy.set(lst.id, [...(usedBy.get(lst.id) ?? []), d.name]);
      const bits = [`min ${info.min_selected_modifiers ?? "-"}`, `max ${info.max_selected_modifiers ?? "-"}`, info.enabled === false && "DISABLED", info.hidden_from_customer && "hidden_from_customer", `ordinal ${info.ordinal ?? "-"}`].filter(Boolean);
      L.push(`    ◦ modifiers: ${lname}  (${bits.join(", ")})`);
      for (const o of info.modifier_overrides ?? []) {
        const m = (lst?.modifier_list_data?.modifiers ?? []).find((x) => x.id === o.modifier_id);
        L.push(`        override ${m?.modifier_data?.name ?? o.modifier_id}: ${JSON.stringify({ ...o, modifier_id: undefined })}`);
      }
    }
  }

  // --- Modifier lists
  L.push("", `=== MODIFIER LISTS (${lists.length}) ===`);
  for (const lst of lists.sort((a, b) => a.modifier_list_data.name.localeCompare(b.modifier_list_data.name))) {
    const ld = lst.modifier_list_data;
    L.push("", `• ${ld.name}  (${lst.id})${here(lst)}`);
    L.push(`    type: ${ld.modifier_type ?? "LIST"}   selection_type: ${ld.selection_type ?? "—"}   min: ${ld.min_selected_modifiers ?? "—"}   max: ${ld.max_selected_modifiers ?? "—"}${flag(ld.hidden_from_customer, "hidden_from_customer")}`);
    L.push(`    used by: ${(usedBy.get(lst.id) ?? []).join(", ") || "(no items)"}`);
    if (ld.modifier_type === "TEXT") warn.push(`Modifier list "${ld.name}" is TEXT (not supported online; will be skipped).`);
    let visible = 0;
    for (const m of ld.modifiers ?? []) {
      const md = m.modifier_data;
      const ov = (md.location_overrides ?? []).find((o) => o.location_id === locationId);
      const kids = childLists(md);
      const shown = isPresentAt(m, locationId) && !md.hidden_online;
      if (shown) visible++;
      L.push(`    - ${(md.name ?? "").padEnd(24)} ${money(md.price_money).padStart(8)}${ov?.price_money ? "  override " + money(ov.price_money) : ""}${flag(ov?.sold_out, "SOLD OUT")}${flag(md.hidden_online, "hidden_online")}${flag(md.on_by_default, "on_by_default")}${here(m)}${kids.length ? "  children: " + kids.map(name).join(", ") : ""}`);
      if (kids.length) warn.push(`Modifier "${ld.name} / ${md.name}" has nested lists (${kids.map(name).join(", ")}): not supported.`);
    }
    // Required lists with nothing visible, at list level or via item override.
    for (const it of items) {
      const info = (it.item_data.modifier_list_info ?? []).find((i) => i.modifier_list_id === lst.id);
      if (!info || info.enabled === false || ld.modifier_type === "TEXT") continue; // TEXT lists are skipped online
      const min = info.min_selected_modifiers > 0 ? info.min_selected_modifiers : ld.min_selected_modifiers ?? 0;
      const hiddenByOverride = new Set((info.modifier_overrides ?? []).filter((o) => o.hidden_online).map((o) => o.modifier_id));
      const vis = (ld.modifiers ?? []).filter((m) => isPresentAt(m, locationId) && !m.modifier_data.hidden_online && !hiddenByOverride.has(m.id)).length;
      if (min > 0 && vis < min) warn.push(`Item "${it.item_data.name}" requires ${min} from "${ld.name}" but only ${vis} modifier(s) are visible online.`);
    }
    if (!visible) L.push("    (no modifiers visible online)");
  }

  // --- What the site will show, with the current settings
  if (env.HIDE_CATEGORIES || env.LUNCH_ONLY_CATEGORIES) {
    const warnFn = console.warn;
    console.warn = () => {}; // exclusions are already listed as warnings
    const { menu } = normalizeMenu(objects, location ?? {}, { ...env, SQUARE_LOCATION_ID: locationId });
    console.warn = warnFn;
    const shown = menu.categories.flatMap((c) => c.items.map((it) => ({ ...it, cat: c.name })));
    L.push("", `=== ONLINE MENU (${shown.length} items in ${menu.categories.length} sections) ===`);
    for (const c of menu.categories) L.push(`  ${c.name.padEnd(32)} ${String(c.items.length).padStart(3)} items`);
    const lunch = shown.filter((it) => it.lunchOnly);
    const allDay = new Map(); // pairKey -> all-day items
    for (const it of shown) {
      if (it.lunchOnly) continue;
      const k = pairKey(it.name);
      allDay.set(k, [...(allDay.get(k) ?? []), it]);
    }
    L.push("", `=== LUNCH ONLY (${lunch.length}), with the all-day version when one matches by name ===`);
    for (const it of lunch) {
      const twins = allDay.get(pairKey(it.name)) ?? [];
      const flags = new Set(twins.map((t) => (minPrice(t) === minPrice(it) ? "  ! SAME PRICE" : minPrice(t) < minPrice(it) ? "  ! LUNCH COSTS MORE" : "")));
      const vs = twins.length ? `   vs  ${twins.map((t) => `${t.name} ${priceRange(t)} [${t.cat}]`).join(", ")}` : "";
      L.push(`  ${`${it.name} ${priceRange(it)}`.padEnd(40)} [${it.cat}]${vs}${[...flags].join("")}`);
    }
  }

  L.push("", `=== WARNINGS (${warn.length}) ===`, ...(warn.length ? [...new Set(warn)].map((w) => "  ! " + w) : ["  none"]));
  return L.join("\n");
}

async function main() {
  const env = loadEnv();
  const which = env.SQUARE_ENV === "production" ? "PRODUCTION" : "sandbox";
  console.log(`Square ${which} · location ${env.SQUARE_LOCATION_ID}`);
  const [objects, location] = await Promise.all([listCatalog(env), getLocation(env)]);
  console.log(`${objects.length} catalog objects\n`);
  console.log(buildReport(objects, location, env.SQUARE_LOCATION_ID, env));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message); // message only: never the env/token
    if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
    if (e.status === 401) console.error("\nSquare rejected the token. Check that SQUARE_ENV matches where the token came from (sandbox or production), and that the token was pasted whole, with no quotes or spaces.");
    process.exit(1);
  });
}
