import { getMenu } from "../../lib/square.js";
import { pickupOptions, pickupSettings, wallClock } from "../../lib/pickup.js";

export async function onRequestGet({ env }) {
  try {
    const { menu, location } = await getMenu(env);
    const pickup = pickupOptions(location, pickupSettings(env));
    // Today's weekday at the restaurant, so the page can show today's hours.
    const today = wallClock(Date.now(), location?.timezone || "America/New_York").dow;
    return Response.json({ ...menu, restaurant: { ...menu.restaurant, today }, pickup }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (e) {
    console.error("GET /api/menu failed:", e.message, JSON.stringify(e.errors ?? []));
    return Response.json({ error: "The menu is unavailable right now. Please call us to order." }, { status: 502 });
  }
}
