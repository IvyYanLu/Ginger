import { getMenu, sq, validateLine } from "../../lib/square.js";
import { pickupOptions, pickupSettings, prepAt, toDuration } from "../../lib/pickup.js";

const MAX_LINES = 50;
const json = (body, status = 200) => Response.json(body, { status });

// Shape checks only (400). Menu-dependent checks happen later (409).
export function parseCheckout(body) {
  if (!body || typeof body !== "object") return { error: "Invalid request." };
  const { items, name, note = "", pickupAt = null } = body;
  if (!Array.isArray(items) || !items.length) return { error: "Your order is empty." };
  if (items.length > MAX_LINES) return { error: `Orders are limited to ${MAX_LINES} lines. Please call us for large orders.` };
  for (const l of items) {
    if (!l || typeof l.id !== "string" || (l.modifiers != null && !Array.isArray(l.modifiers)) ||
        (l.modifiers ?? []).some((m) => typeof m !== "string")) return { error: "Invalid request." };
  }
  if (typeof name !== "string" || !name.trim()) return { error: "Please add a name for pickup." };
  if (name.trim().length > 60) return { error: "Name must be 60 characters or fewer." };
  if (typeof note !== "string" || note.trim().length > 500) return { error: "Notes must be 500 characters or fewer." };
  if (pickupAt !== null && typeof pickupAt !== "string") return { error: "Invalid pickup time." };
  return {
    lines: items.map((l) => ({ id: l.id, modifiers: l.modifiers ?? [], qty: l.qty })),
    name: name.trim(),
    note: note.trim(),
    pickupAt,
  };
}

// Pure: the CreatePaymentLink request body. Square prices everything from the
// catalog: no base_price_money anywhere.
export function paymentLinkBody({ env, lines, name, note, pickup, idempotencyKey }) {
  const pickup_details = {
    recipient: { display_name: name },
    schedule_type: pickup.at ? "SCHEDULED" : "ASAP",
    ...(pickup.at && { pickup_at: pickup.at }),
    prep_time_duration: toDuration(pickup.prepMinutes),
    ...(note && { note }),
  };
  return {
    idempotency_key: idempotencyKey,
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: lines.map((l) => ({
        catalog_object_id: l.id,
        quantity: String(l.qty),
        ...(l.modifiers.length && { modifiers: l.modifiers.map((id) => ({ catalog_object_id: id })) }),
      })),
      pricing_options: { auto_apply_taxes: true },
      fulfillments: [{ type: "PICKUP", pickup_details }],
    },
    checkout_options: {
      redirect_url: `${env.SITE_URL}/?status=success`,
      ask_for_shipping_address: false,
      allow_tipping: true,
      // Instant methods only. ACH is on by default for eligible sellers but
      // settles days later, so the redirect would not mean "paid": off.
      // Afterpay (installments) off by the owner's choice. Apple Pay and
      // Google Pay follow the seller's settings.
      accepted_payment_methods: { cash_app_pay: true, afterpay_clearpay: false, bank_account: false },
      enable_coupon: false,  // hide Square's coupon box
      enable_loyalty: false, // hide Square's loyalty/rewards box
    },
    payment_note: `Pickup for: ${name}${note ? " — " + note : ""}`.slice(0, 500),
  };
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const parsed = parseCheckout(body);
  if (parsed.error) return json({ error: parsed.error }, 400);

  let menu, location, restaurant;
  try {
    ({ index: menu, location, menu: { restaurant } } = await getMenu(env));
  } catch (e) {
    console.error("checkout: menu load failed:", e.message, JSON.stringify(e.errors ?? []));
    return json({ error: "Online ordering is unavailable right now. Please call us to order." }, 502);
  }

  for (const l of parsed.lines) {
    const msg = validateLine(menu[l.id], l.id, l.modifiers, l.qty);
    if (msg) return json({ error: msg, stale: true }, 409);
  }

  const now = Date.now();
  const settings = pickupSettings(env);
  const opts = pickupOptions(location, settings, now);
  const tz = location?.timezone || "America/New_York";
  // Lunch-only items need a pickup time inside the lunch window.
  const lunchItems = [...new Set(parsed.lines.map((l) => menu[l.id]).filter((it) => it.lunchOnly).map((it) => it.name))];
  const lunchError = () => json({
    error: `${lunchItems.join(", ")} ${lunchItems.length > 1 ? "are" : "is"} lunch only (pickup ${opts.lunchLabel}). Please choose a lunch pickup time or remove ${lunchItems.length > 1 ? "them" : "it"}.`,
    stale: true,
  }, 409);
  let pickup;
  if (parsed.pickupAt) {
    const slot = opts.slots.find((s) => s.at === parsed.pickupAt);
    if (!slot) {
      return json({ error: "That pickup time is no longer available. Please choose another.", stale: true }, 409);
    }
    if (lunchItems.length && !slot.lunch) return lunchError();
    pickup = { at: parsed.pickupAt, prepMinutes: prepAt(Date.parse(parsed.pickupAt), tz, settings.base, settings.busy) };
  } else {
    if (!opts.asap.available) {
      return json({ error: "We can't take ASAP orders right now. Please choose a pickup time.", stale: true }, 409);
    }
    if (lunchItems.length && !opts.asap.lunch) return lunchError();
    pickup = { at: null, prepMinutes: opts.asap.minutes };
  }

  try {
    const res = await sq(env, "/v2/online-checkout/payment-links", {
      method: "POST",
      body: JSON.stringify(paymentLinkBody({ env, ...parsed, pickup, idempotencyKey: crypto.randomUUID() })),
    });
    return json({ url: res.payment_link.url });
  } catch (e) {
    console.error("checkout: CreatePaymentLink failed:", e.message, JSON.stringify(e.errors ?? []));
    const phone = restaurant?.phone ? ` at ${restaurant.phone}` : "";
    return json({ error: `Sorry, we couldn't start checkout. Please call us${phone} to order.` }, 502);
  }
}
