import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/menu.js";
import { resetMenuCache } from "../lib/square.js";
import { objects, location, env } from "./fixtures/catalog.js";

beforeEach(() => resetMenuCache());

const squareMock = (t, fail) => t.mock.method(globalThis, "fetch", async (url, init) => {
  assert.equal(init.headers.Authorization, "Bearer test-token");
  if (fail) return new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED" }] }), { status: 401 });
  if (url.includes("/v2/locations/")) return Response.json({ location });
  return Response.json({ objects });
});

test("GET /api/menu returns the normalized menu with cache header; caches 60 s", async (t) => {
  const f = squareMock(t);
  const res = await onRequestGet({ env });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
  const body = await res.json();
  assert.equal(body.restaurant.name, "Ginger Japanese Restaurant");
  assert.equal(body.categories[0].name, "Appetizers");
  assert.equal(typeof body.pickup.asap.available, "boolean");
  assert.ok(Array.isArray(body.pickup.slots));
  await onRequestGet({ env });
  assert.equal(f.mock.callCount(), 2, "second request served from cache");
});

test("GET /api/menu returns 502 on Square error and never logs the token", async (t) => {
  squareMock(t, true);
  const logs = [];
  t.mock.method(console, "error", (...a) => logs.push(a.join(" ")));
  const res = await onRequestGet({ env });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /call us/);
  assert.match(logs.join(), /UNAUTHORIZED/);
  assert.doesNotMatch(logs.join(), /test-token/);
});
