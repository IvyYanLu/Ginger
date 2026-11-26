import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/checkout.js";
import { resetMenuCache } from "../lib/square.js";
import { objects, location, env } from "./fixtures/catalog.js";

const FULL_ENV = { ...env, BUSY_PREP_TIME: "FRI-SAT 17:00-19:00 PT30M", PICKUP_CUTOFF: "MON-FRI:10,SAT-SUN:15" };
const FRI_530PM = Date.parse("2026-11-27T22:30:00Z");
const SAT_940PM = Date.parse("2026-11-29T02:40:00Z");

beforeEach(() => resetMenuCache());

function setup(t, { now = FRI_530PM, linkStatus = 200 } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/v2/locations/")) return Response.json({ location });
    if (url.includes("/v2/catalog/list")) return Response.json({ objects });
    if (url.endsWith("/v2/online-checkout/payment-links")) {
      return linkStatus === 200
        ? Response.json({ payment_link: { id: "PL1", url: "https://square.link/u/abc" } })
        : Response.json({ errors: [{ code: "INVALID_REQUEST_ERROR", detail: "bad" }] }, { status: linkStatus });
    }
    throw new Error("unexpected " + url);
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  return calls;
}
const post = (body, raw) => onRequestPost({
  env: FULL_ENV,
  request: new Request("https://order.example/api/checkout", { method: "POST", body: raw ?? JSON.stringify(body) }),
});
const good = {
  items: [
    { id: "V_CAL_8", modifiers: ["M_BROWN", "M_EEL"], qty: 2 },
    { id: "V_EDA", modifiers: [], qty: 1 },
  ],
  name: "  Alex  ", note: "No sesame please",
};

test("ASAP order: exact CreatePaymentLink request", async (t) => {
  const calls = setup(t);
  const res = await post(good);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: "https://square.link/u/abc" });
  const call = calls.find((c) => c.url.endsWith("/payment-links"));
  assert.equal(call.url, "https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, "Bearer test-token");
  const sent = JSON.parse(call.init.body);
  assert.match(sent.idempotency_key, /^[0-9a-f-]{36}$/);
  delete sent.idempotency_key;
  assert.deepEqual(sent, {
    order: {
      location_id: "LOC1",
      line_items: [
        { catalog_object_id: "V_CAL_8", quantity: "2", modifiers: [{ catalog_object_id: "M_BROWN" }, { catalog_object_id: "M_EEL" }] },
        { catalog_object_id: "V_EDA", quantity: "1" },
      ],
      pricing_options: { auto_apply_taxes: true },
      fulfillments: [{ type: "PICKUP", pickup_details: {
        recipient: { display_name: "Alex" }, schedule_type: "ASAP", prep_time_duration: "PT30M", note: "No sesame please",
      } }],
    },
    checkout_options: { redirect_url: "https://order.example/?status=success", ask_for_shipping_address: false, allow_tipping: true },
    payment_note: "Pickup for: Alex — No sesame please",
  });
  assert.ok(!JSON.stringify(sent).includes("base_price_money"));
  assert.ok(!JSON.stringify(sent).includes("buyer_email"));
});

test("scheduled order: SCHEDULED with pickup_at and prep for that time", async (t) => {
  const calls = setup(t);
  const res = await post({ ...good, note: "", pickupAt: "2026-11-28T16:00:00.000Z" }); // Sat 11:00am (opening)
  assert.equal(res.status, 200);
  const sent = JSON.parse(calls.find((c) => c.url.endsWith("/payment-links")).init.body);
  assert.deepEqual(sent.order.fulfillments[0].pickup_details, {
    recipient: { display_name: "Alex" }, schedule_type: "SCHEDULED", pickup_at: "2026-11-28T16:00:00.000Z", prep_time_duration: "PT20M",
  });
  assert.equal(sent.payment_note, "Pickup for: Alex");
});

test("400 on bad input", async (t) => {
  setup(t);
  const cases = [
    [null, "{not json"],
    [{ items: [], name: "A" }],
    [{ items: good.items, name: "   " }],
    [{ items: good.items, name: "x".repeat(61) }],
    [{ items: good.items, name: "A", note: "x".repeat(501) }],
    [{ items: Array(51).fill(good.items[1]), name: "A" }],
    [{ items: [{ id: 5, qty: 1 }], name: "A" }],
    [{ items: [{ id: "V_EDA", modifiers: "M", qty: 1 }], name: "A" }],
    [{ ...good, pickupAt: 123 }],
  ];
  for (const [body, raw] of cases) assert.equal((await post(body, raw)).status, 400, JSON.stringify(body) ?? raw);
});

test("409 stale on invalid lines and unavailable times", async (t) => {
  setup(t);
  const cases = [
    { items: [{ id: "V_SAKE", qty: 1 }], name: "A" },                          // hidden category
    { items: [{ id: "V_CAL_4", modifiers: ["M_WHITE"], qty: 1 }], name: "A" }, // sold out
    { items: [{ id: "V_CAL_8", modifiers: [], qty: 1 }], name: "A" },          // required list
    { items: [{ id: "V_CAL_8", modifiers: ["M_WHITE", "M_RUSH"], qty: 1 }], name: "A" }, // hidden list
    { items: [{ id: "V_EDA", qty: 0 }], name: "A" },
    { items: [{ id: "V_EDA", qty: 1 }], name: "A", pickupAt: "2026-11-27T22:45:00.000Z" }, // before now+prep
    { items: [{ id: "V_EDA", qty: 1 }], name: "A", pickupAt: "2026-11-27T23:07:00.000Z" }, // not a slot
  ];
  for (const body of cases) {
    const res = await post(body);
    assert.equal(res.status, 409, JSON.stringify(body));
    const j = await res.json();
    assert.equal(j.stale, true);
    assert.ok(j.error);
  }
});

test("409 when ASAP is unavailable (after last pickup)", async (t) => {
  setup(t, { now: SAT_940PM });
  const res = await post(good);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /choose a pickup time/);
});

test("502 with phone number when Square rejects the payment link", async (t) => {
  setup(t, { linkStatus: 400 });
  const res = await post(good);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /call us at \+17815550100/);
});
