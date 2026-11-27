import { getMenu } from "../../lib/square.js";
import { pickupOptions, pickupSettings, businessDay } from "../../lib/pickup.js";

export async function onRequestGet({ env }) {
  try {
    const { menu, location } = await getMenu(env);
    const pickup = pickupOptions(location, pickupSettings(env));
    // The restaurant's business day (yesterday while a past-midnight period is
    // still open), so the page shows the hours that apply right now.
    const today = businessDay(location);
    // Pickup times change by the minute: don't let browsers reuse a stale copy.
    return Response.json({ ...menu, restaurant: { ...menu.restaurant, today }, pickup }, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (e) {
    console.error("GET /api/menu failed:", e.message, JSON.stringify(e.errors ?? []));
    return Response.json({ error: "The menu is unavailable right now. Please call us to order." }, { status: 502 });
  }
}
