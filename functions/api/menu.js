import { getMenu } from "../../lib/square.js";
import { pickupOptions, pickupSettings } from "../../lib/pickup.js";

export async function onRequestGet({ env }) {
  try {
    const { menu, location } = await getMenu(env);
    const pickup = pickupOptions(location, pickupSettings(env));
    return Response.json({ ...menu, pickup }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (e) {
    console.error("GET /api/menu failed:", e.message, JSON.stringify(e.errors ?? []));
    return Response.json({ error: "The menu is unavailable right now. Please call us to order." }, { status: 502 });
  }
}
