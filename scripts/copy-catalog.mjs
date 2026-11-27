#!/usr/bin/env node
// Copies the restaurant's real catalog (production) into a Square SANDBOX, so
// test orders use the real menu: categories (with POS menu groups), taxes,
// modifier lists and items. Photos are not copied. It also copies the
// location's name, address, phone, time zone and hours onto the sandbox location.
//
//   node scripts/copy-catalog.mjs            dry run: prints what it would copy
//   node scripts/copy-catalog.mjs --apply    copies
//
// Reads .dev.vars.production (source) and .dev.vars.sandbox (target). The
// source is only read. Writing is refused unless the target is a sandbox, and
// refused if the sandbox already has items (pass --force to copy anyway, which
// adds duplicates).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sq, listCatalog, getLocation, isPresentAt } from "../lib/square.js";
import { parseDevVars } from "./dump-catalog.mjs";

const TYPES = "ITEM,CATEGORY,MODIFIER_LIST,TAX";
const MAX_BATCH_OBJECTS = 1000; // Square's per-batch limit, nested objects included

// Split objects into chunks whose total size(o) stays within the batch limit.
function chunkBy(objs, size) {
  const out = [];
  let cur = [], n = 0;
  for (const o of objs) {
    const k = size(o);
    if (k > MAX_BATCH_OBJECTS) throw new Error(`"${o.item_data?.name ?? o.modifier_list_data?.name ?? o.id}" alone has ${k} objects, over Square's ${MAX_BATCH_OBJECTS}-object batch limit.`);
    if (cur.length && n + k > MAX_BATCH_OBJECTS) { out.push(cur); cur = []; n = 0; }
    cur.push(o); n += k;
  }
  if (cur.length) out.push(cur);
  return out;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const tmp = (id) => "#" + id;

// Location overrides for the source location, moved to the target location.
function moveOverrides(list, fromLoc, toLoc, keys) {
  const out = (list ?? []).filter((o) => o.location_id === fromLoc).map((o) => ({ ...pick(o, keys), location_id: toLoc }));
  return out.length ? out : undefined;
}

// Pure: source objects -> ordered phases of objects to upsert. Each phase is
// sent after the previous one, so references to earlier phases are resolved
// to real sandbox ids with `real(id)` at send time; within a phase, nested
// objects use temporary "#" ids.
export function buildPhases(objects, fromLoc, toLoc) {
  const live = objects.filter((o) => !o.is_deleted && isPresentAt(o, fromLoc));
  const byType = (t) => live.filter((o) => o.type === t);
  const phases = [];

  // 1. Taxes.
  phases.push({ name: "taxes", objects: byType("TAX"), build: (o) => ({
    type: "TAX", id: tmp(o.id), present_at_all_locations: true,
    tax_data: pick(o.tax_data, ["name", "calculation_phase", "inclusion_type", "percentage", "applies_to_custom_amounts", "enabled"]),
  }) });

  // 2. Categories, parents before children (POS menu groups have a parent).
  const cats = byType("CATEGORY");
  const placed = new Set();
  for (let level = 0; placed.size < cats.length && level < 10; level++) {
    const ready = cats.filter((c) => !placed.has(c.id) && (!c.category_data?.parent_category?.id || placed.has(c.category_data.parent_category.id) || !cats.some((p) => p.id === c.category_data.parent_category.id)));
    ready.forEach((c) => placed.add(c.id));
    phases.push({ name: `categories (level ${level + 1})`, objects: ready, build: (o, real) => {
      const d = o.category_data ?? {};
      const parent = d.parent_category?.id && real(d.parent_category.id);
      return {
        type: "CATEGORY", id: tmp(o.id), present_at_all_locations: true,
        category_data: { ...pick(d, ["name", "category_type", "online_visibility"]), ...(parent && { parent_category: { id: parent, ...pick(d.parent_category, ["ordinal"]) } }) },
      };
    } });
  }

  // 3. Modifier lists with their modifiers, chunked by list + modifier count.
  // Count only what build() sends: live modifiers / variations at the source location.
  const sent = (arr) => (arr ?? []).filter((x) => !x.is_deleted && isPresentAt(x, fromLoc)).length;
  const listChunks = chunkBy(byType("MODIFIER_LIST"), (o) => 1 + sent(o.modifier_list_data?.modifiers));
  listChunks.forEach((chunk, ci) => phases.push({ name: listChunks.length > 1 ? `modifier lists (part ${ci + 1})` : "modifier lists", objects: chunk, build: (o) => {
    const d = o.modifier_list_data ?? {};
    return {
      type: "MODIFIER_LIST", id: tmp(o.id), present_at_all_locations: true,
      modifier_list_data: {
        ...pick(d, ["name", "ordinal", "selection_type", "modifier_type", "min_selected_modifiers", "max_selected_modifiers", "hidden_from_customer", "text_required", "max_length", "internal_name"]),
        ...(d.modifiers && { modifiers: d.modifiers.filter((m) => !m.is_deleted && isPresentAt(m, fromLoc)).map((m) => ({
          type: "MODIFIER", id: tmp(m.id), present_at_all_locations: true,
          modifier_data: {
            ...pick(m.modifier_data, ["name", "price_money", "ordinal", "on_by_default", "hidden_online"]),
            modifier_list_id: tmp(o.id),
            ...(moveOverrides(m.modifier_data?.location_overrides, fromLoc, toLoc, ["price_money", "sold_out"]) && { location_overrides: moveOverrides(m.modifier_data.location_overrides, fromLoc, toLoc, ["price_money", "sold_out"]) }),
          },
        })) }),
      },
    };
  } }));

  // 4. Items with their variations, chunked by item + variation count.
  let first = 1;
  for (const chunk of chunkBy(byType("ITEM"), (o) => 1 + sent(o.item_data?.variations))) {
    const range = `${first}–${first + chunk.length - 1}`;
    first += chunk.length;
    phases.push({ name: `items ${range}`, objects: chunk, build: (o, real) => {
      const d = o.item_data ?? {};
      const ref = (r) => (r?.id && real(r.id) ? { id: real(r.id), ...pick(r, ["ordinal"]) } : undefined);
      const variations = (d.variations ?? []).filter((v) => !v.is_deleted && isPresentAt(v, fromLoc)).map((v) => {
        const vd = v.item_variation_data ?? {};
        const ov = moveOverrides(vd.location_overrides, fromLoc, toLoc, ["price_money", "sold_out"]);
        return {
          type: "ITEM_VARIATION", id: tmp(v.id), present_at_all_locations: true,
          item_variation_data: { ...pick(vd, ["name", "ordinal", "pricing_type", "price_money", "sku", "sellable", "stockable"]), item_id: tmp(o.id), ...(ov && { location_overrides: ov }) },
        };
      });
      const lists = (d.modifier_list_info ?? []).filter((m) => real(m.modifier_list_id)).map((m) => ({
        ...pick(m, ["min_selected_modifiers", "max_selected_modifiers", "enabled", "ordinal", "hidden_from_customer"]),
        modifier_list_id: real(m.modifier_list_id),
        ...(m.modifier_overrides && { modifier_overrides: m.modifier_overrides.filter((x) => real(x.modifier_id)).map((x) => ({ ...pick(x, ["on_by_default", "hidden_online"]), modifier_id: real(x.modifier_id) })) }),
      }));
      const categories = (d.categories ?? []).map(ref).filter(Boolean);
      const taxes = (d.tax_ids ?? []).map(real).filter(Boolean);
      return {
        type: "ITEM", id: tmp(o.id), present_at_all_locations: true,
        item_data: {
          ...pick(d, ["name", "abbreviation", "label_color", "is_taxable", "product_type", "skip_modifier_screen", "ecom_visibility", "is_archived"]),
          ...(d.description_html ? { description_html: d.description_html } : d.description ? { description: d.description } : {}),
          ...(ref(d.reporting_category) && { reporting_category: ref(d.reporting_category) }),
          ...(categories.length && { categories }),
          ...(taxes.length && { tax_ids: taxes }),
          ...(lists.length && { modifier_list_info: lists }),
          variations,
        },
      };
    } });
  }
  return phases.filter((p) => p.objects.length);
}

// The location fields worth copying onto the sandbox location.
export function locationUpdate(src) {
  return pick(src, ["name", "address", "phone_number", "timezone", "business_hours", "description"]);
}

export function loadPair(dir = new URL("..", import.meta.url)) {
  const read = (f) => parseDevVars(readFileSync(new URL(f, dir), "utf8"));
  return { from: read(".dev.vars.production"), to: read(".dev.vars.sandbox") };
}

export async function copyCatalog({ from, to, apply = false, force = false, log = console.log }) {
  if (to.SQUARE_ENV !== "sandbox") throw new Error("Refusing to write: the target (.dev.vars.sandbox) must have SQUARE_ENV=sandbox.");
  if (from.SQUARE_ENV !== "production") throw new Error("The source (.dev.vars.production) must have SQUARE_ENV=production.");
  for (const [n, e] of [["production", from], ["sandbox", to]]) {
    if (!e.SQUARE_ACCESS_TOKEN || !e.SQUARE_LOCATION_ID) throw new Error(`Missing token or location ID in the ${n} file.`);
  }
  const [objects, srcLoc] = await Promise.all([listCatalog(from, TYPES), getLocation(from)]);
  const phases = buildPhases(objects, from.SQUARE_LOCATION_ID, to.SQUARE_LOCATION_ID);
  log(`Production: ${objects.length} objects at ${srcLoc?.name ?? from.SQUARE_LOCATION_ID}.`);
  for (const p of phases) log(`  ${p.name}: ${p.objects.length}`);
  log(`Location: ${srcLoc?.name}, ${srcLoc?.timezone}, ${srcLoc?.business_hours?.periods?.length ?? 0} hour periods`);

  const existing = await listCatalog(to, "ITEM");
  if (existing.length && !force) throw new Error(`The sandbox already has ${existing.length} items. Copying again would duplicate them. Delete them in the sandbox Dashboard, or pass --force.`);
  if (!apply) { log("\nDry run: nothing was changed. Run again with --apply to copy."); return { applied: false }; }

  await sq(to, `/v2/locations/${to.SQUARE_LOCATION_ID}`, { method: "PUT", body: JSON.stringify({ location: locationUpdate(srcLoc) }) });
  log("Updated the sandbox location (name, address, phone, time zone, hours).");

  const ids = new Map(); // production id -> sandbox id
  const real = (id) => ids.get(id);
  for (const p of phases) {
    const res = await sq(to, "/v2/catalog/batch-upsert", {
      method: "POST",
      body: JSON.stringify({ idempotency_key: crypto.randomUUID(), batches: [{ objects: p.objects.map((o) => p.build(o, real)) }] }),
    });
    for (const m of res.id_mappings ?? []) ids.set(m.client_object_id.slice(1), m.object_id);
    log(`  copied ${p.name}`);
  }
  log(`\nDone: ${ids.size} objects copied. Run node scripts/dump-catalog.mjs with the sandbox settings to check.`);
  return { applied: true, copied: ids.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  copyCatalog({ ...loadPair(), apply: args.has("--apply"), force: args.has("--force") }).catch((e) => {
    console.error(e.message); // message only: never a token
    if (e.errors) console.error(JSON.stringify(e.errors, null, 2));
    process.exit(1);
  });
}
