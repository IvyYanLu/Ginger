// Cart line validation. One copy, used by the page (public/index.html) and by
// the server (re-exported from lib/square.js, bundled into the Functions).
// No imports: it must run unchanged in the browser and in Workers.
export function validateLine(item, variationId, modifierIds, qty) {
  if (!item) return "An item in your order is no longer available.";
  const v = item.variations.find((x) => x.id === variationId);
  if (!v) return `${item.name} is no longer available in that size.`;
  if (v.soldOut) return `${item.name}${item.variations.length > 1 ? " (" + v.label + ")" : ""} is sold out.`;
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) return `Quantity for ${item.name} must be 1 to 20.`;
  const ids = Array.isArray(modifierIds) ? modifierIds : [];
  if (new Set(ids).size !== ids.length) return `An option for ${item.name} was selected twice.`;
  const listOf = new Map();
  for (const l of item.modifierLists) for (const m of l.modifiers) listOf.set(m.id, l.id);
  if (ids.some((id) => !listOf.has(id))) return `An option for ${item.name} is no longer available.`;
  for (const l of item.modifierLists) {
    const n = ids.filter((id) => listOf.get(id) === l.id).length;
    if (n < l.min) return `Choose ${l.min > 1 ? l.min + " options" : "an option"} for ${l.name} (${item.name}).`;
    if (l.max != null && n > l.max) return `Choose at most ${l.max} for ${l.name} (${item.name}).`;
  }
  return null;
}
