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
