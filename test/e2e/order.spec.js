import { test, expect } from "@playwright/test";
import { normalizeMenu } from "../../lib/square.js";
import { pickupOptions, pickupSettings } from "../../lib/pickup.js";
import { objects, location, env } from "../fixtures/catalog.js";

// Menu as /api/menu would return it; open all day so ASAP is available whenever the test runs.
function menuJson({ requiredRice = true, lunch = false } = {}) {
  const e = lunch ? { ...env, LUNCH_HOURS: "MON-SUN 11:00-14:30", LUNCH_ONLY_CATEGORIES: "Entrées" } : env;
  const warn = console.warn;
  console.warn = () => {}; // the fixture's excluded items are expected
  const { menu } = normalizeMenu(objects, location, e);
  console.warn = warn;
  const m = structuredClone(menu);
  if (requiredRice) for (const c of m.categories) for (const it of c.items) for (const l of it.modifierLists) {
    if (l.name === "Rice") l.modifiers.forEach((x) => (x.default = false));
  }
  const allDay = { timezone: "America/New_York", business_hours: { periods: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    .map((d) => ({ day_of_week: d, start_local_time: "00:00", end_local_time: "23:59" })) } };
  return { ...m, restaurant: { ...m.restaurant, today: "FRI" }, pickup: pickupOptions(allDay, pickupSettings(e)) };
}

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (msg) => msg.type() === "error" && page.errors.push(msg.text()));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://img.example/**", (r) => r.fulfill({ contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAAAAACw=", "base64") }));
  await page.route("**/api/menu", (r) => r.fulfill({ json: menuJson() }));
});
// No console errors, except the browser's own log line for a deliberate 409.
test.afterEach(async ({ page }) => expect(page.errors.filter((e) => !/status of 409/.test(e))).toEqual([]));

const card = (page, name) => page.locator(".card", { has: page.getByRole("heading", { name, exact: true }) });

test("header, categories and no horizontal scroll at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto("/");
  await expect(page.locator("#rMeta")).toContainText("1 Main St, Bedford, MA 01730");
  await expect(page.locator("header").getByRole("link", { name: "(781) 555-0100" })).toHaveAttribute("href", "tel:+17815550100");
  const hours = page.locator("#rHours");
  await expect(hours.locator("summary")).toHaveText("Today’s hours11am – 2:30pm, then 4pm – 10pmAll hours");
  await expect(hours.locator("table")).toBeHidden();
  await hours.getByText("All hours").click();
  await expect(hours.locator("tr")).toHaveText(["Mon–Thu11am – 2:30pm4pm – 9:30pm", "Fri11am – 2:30pm4pm – 10pm", "Sat11am – 10pm", "Sun12pm – 9:30pm"]);
  await expect(hours.locator("tr.today th")).toHaveText("Fri");
  await expect(page.locator("nav a")).toHaveText(["Appetizers", "Entrées", "Maki", "Other", "Desserts", "Drinks"]);
  await expect(page.getByText("House Sake")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("one-tap add becomes a stepper", async ({ page }) => {
  await page.goto("/");
  const eda = card(page, "Edamame");
  await eda.getByRole("button", { name: "Add Edamame" }).click();
  await expect(eda.locator(".step span")).toHaveText("1");
  await eda.getByRole("button", { name: "Add one more Edamame" }).click();
  await expect(page.locator("#bar")).toContainText("View order · 2 items$12.00");
  await eda.getByRole("button", { name: "Remove one Edamame" }).click();
  await eda.getByRole("button", { name: "Remove one Edamame" }).click();
  await expect(page.locator("#bar")).toBeHidden();
  await expect(eda.getByRole("button", { name: "Add Edamame" })).toBeVisible();
});

test("bottom sheet with a required list, max lock, live price; cart total; checkout redirect", async ({ page }) => {
  await page.goto("/");
  await card(page, "Edamame").getByRole("button", { name: "Add Edamame" }).click();
  // Cards show one base price (cheapest available size + required choices), never a range.
  await expect(card(page, "California Roll").locator(".price")).toHaveText("$9.00");
  await expect(page.locator(".card .price", { hasText: "–" })).toHaveCount(0);
  await card(page, "California Roll").getByRole("button", { name: /Choose options/ }).click();
  const sheet = page.locator("#itemSheet");
  await expect(sheet.locator(".opt", { hasText: "8 pc" }).locator("em")).toHaveText(""); // the base size adds nothing
  await expect(sheet.getByRole("radio", { name: /4 pc/ })).toBeDisabled();
  await expect(sheet.getByRole("radio", { name: /8 pc/ })).toBeChecked();
  const add = sheet.locator("#sheetAdd");
  await expect(add).toBeDisabled();
  await expect(add).toHaveText("Make required choices");
  // Defaults: Eel + Spicy checked (max 2), so Tobiko is locked.
  await expect(sheet.getByRole("checkbox", { name: /Tobiko/ })).toBeDisabled();
  await sheet.getByText("Brown rice").click();
  await expect(add).toHaveText("Add to bag · $11.00"); // 9.00 + 1.00 + 0.50 + 0.50
  await sheet.getByRole("button", { name: "Increase quantity" }).click();
  await expect(add).toHaveText("Add to bag · $22.00");
  await add.click();
  await expect(page.locator("#bar")).toContainText("3 items$28.00");

  await page.locator("#viewCart").click();
  const cart = page.locator("#cartSheet");
  await expect(cart).toContainText("8 pc, Brown rice, Eel sauce, Spicy mayo");
  await expect(cart.locator("#subtotal")).toHaveText("$28.00");

  let sent;
  await page.route("**/api/checkout", async (r) => { sent = r.request().postDataJSON(); await r.fulfill({ json: { url: "/square-mock.html" } }); });
  await page.route("**/square-mock.html", (r) => r.fulfill({ contentType: "text/html", body: "<title>Square</title>Square checkout" }));
  await cart.getByRole("button", { name: "Checkout with Square" }).click();
  await expect(cart.locator("#msg")).toContainText("Please add a name");
  await cart.getByLabel("Name for pickup").fill("Alex");
  await cart.getByLabel("Allergies or requests").fill("No sesame");
  await cart.getByRole("button", { name: "Checkout with Square" }).click();
  await page.waitForURL("**/square-mock.html");
  expect(sent).toEqual({
    items: [
      { id: "V_EDA", modifiers: [], qty: 1 },
      { id: "V_CAL_8", modifiers: ["M_BROWN", "M_EEL", "M_SPICY"], qty: 2 },
    ],
    name: "Alex", note: "No sesame", pickupAt: null,
  });
});

test("scheduled pickup sends the chosen slot", async ({ page }) => {
  await page.goto("/");
  await card(page, "Mochi").getByRole("button", { name: "Add Mochi" }).click();
  await page.locator("#viewCart").click();
  await page.getByRole("button", { name: "Schedule" }).click();
  const slot = page.getByRole("combobox", { name: "Pickup time" });
  await expect(slot).toBeVisible();
  const second = await slot.locator("option").nth(1).getAttribute("value");
  await slot.selectOption(second);
  let sent;
  await page.route("**/api/checkout", async (r) => { sent = r.request().postDataJSON(); await r.fulfill({ json: { url: "/square-mock.html" } }); });
  await page.route("**/square-mock.html", (r) => r.fulfill({ contentType: "text/html", body: "ok" }));
  await page.getByLabel("Name for pickup").fill("Sam");
  await page.getByRole("button", { name: "Checkout with Square" }).click();
  await page.waitForURL("**/square-mock.html");
  expect(sent.pickupAt).toBe(second);
});

test("409: refreshes the menu, drops the stale line and explains", async ({ page }) => {
  await page.goto("/");
  await card(page, "Mochi").getByRole("button", { name: "Add Mochi" }).click();
  await card(page, "Edamame").getByRole("button", { name: "Add Edamame" }).click();
  const soldOut = menuJson();
  soldOut.categories.find((c) => c.name === "Desserts").items[0].variations[0].soldOut = true;
  await page.route("**/api/menu", (r) => r.fulfill({ json: soldOut }));
  await page.route("**/api/checkout", (r) => r.fulfill({ status: 409, json: { error: "Mochi is sold out.", stale: true } }));
  await page.locator("#viewCart").click();
  await page.getByLabel("Name for pickup").fill("Alex");
  await page.getByRole("button", { name: "Checkout with Square" }).click();
  await expect(page.locator("#msg")).toContainText("Mochi is sold out. We updated your order: Mochi is sold out.");
  await expect(page.locator("#lines")).not.toContainText("Mochi");
  await expect(page.locator("#subtotal")).toHaveText("$6.00");
  await expect(card(page, "Mochi")).toContainText("Sold out");
});

test("cart persists; ?status=success after our checkout clears it and cleans the URL", async ({ page }) => {
  await page.goto("/");
  await card(page, "Edamame").getByRole("button", { name: "Add Edamame" }).click();
  await page.reload();
  await expect(page.locator("#bar")).toContainText("1 item");
  // A bare ?status=success (bookmark, shared link) keeps the cart.
  await page.goto("/?status=success");
  await expect(page.locator("#bar")).toContainText("1 item");
  expect(new URL(page.url()).search).toBe("");
  // A return from a checkout this tab started clears it.
  await page.evaluate(() => sessionStorage.setItem("ginger-checkout-started", "1"));
  await page.goto("/?status=success");
  await expect(page.locator("#confirm")).toContainText("Thank you!");
  await page.getByRole("button", { name: "Back to menu" }).click();
  await expect(page.locator("#confirm")).toBeHidden();
  await expect(page.locator("#bar")).toBeHidden();
  expect(new URL(page.url()).search).toBe("");
});

test("catalog text is escaped", async ({ page }) => {
  const m = menuJson();
  m.categories[0].items[0].name = '<img src=x onerror="window.pwned=1">';
  await page.route("**/api/menu", (r) => r.fulfill({ json: m }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: '<img src=x onerror="window.pwned=1">' })).toBeVisible();
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test("category nav: click highlights and jumps, scrolling moves the highlight", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto("/");
  const pill = (name) => page.locator("nav a", { hasText: name });
  await expect(pill("Appetizers")).toHaveClass(/\bon\b/);

  for (const name of ["Drinks", "Desserts", "Maki", "Appetizers"]) { // short last sections too
    await pill(name).click();
    await expect(pill(name)).toHaveClass(/\bon\b/);
    await expect(page.locator("nav a.on")).toHaveCount(1);
    await expect(pill(name)).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeInViewport();
    await page.waitForTimeout(1100); // let the click lock expire
    await expect(pill(name)).toHaveClass(/\bon\b/); // still on after the scroll settles
  }

  await page.mouse.wheel(0, 100000); // to the bottom by hand
  await expect(pill("Drinks")).toHaveClass(/\bon\b/);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(pill("Appetizers")).toHaveClass(/\bon\b/);
});

test("lunch group: collapsible, the rest of the menu always shown, state survives re-render", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  const json = menuJson({ lunch: true });
  await page.route("**/api/menu", (r) => r.fulfill({ json }));
  await page.goto("/");
  const lunch = page.locator("#g-lunch");
  await expect(lunch.locator("summary")).toHaveText("LunchDaily 11am–2:30pm");
  await expect(page.locator("details.meal")).toHaveCount(1); // no Dinner group
  await expect(page.locator("nav a")).toHaveText(["Lunch", "Appetizers", "Maki", "Other", "Desserts", "Drinks"]);
  await expect(page.getByText("Lunch only")).toHaveCount(0); // no per-item tags
  // Starts open during lunch, collapsed otherwise (depends on the real clock here).
  const lunchNow = json.pickup.asap.available && json.pickup.asap.lunch;
  expect(await lunch.evaluate((d) => d.open)).toBe(lunchNow);
  await expect(card(page, "Edamame")).toBeVisible(); // the rest is never collapsed

  // Collapse Lunch; the Lunch pill reopens it.
  if (lunchNow) await lunch.locator("summary").click();
  await expect(card(page, "Chicken Teriyaki")).toBeHidden();
  await page.locator("nav a", { hasText: "Lunch" }).click();
  expect(await lunch.evaluate((d) => d.open)).toBe(true);
  await expect(card(page, "Chicken Teriyaki")).toBeVisible();
  // The open group ends with when lunch is served and that the rest sells all day.
  await expect(lunch.locator(".mealend")).toHaveText("Lunch is served daily 11am–2:30pm");
  await expect(page.locator(".allday")).toContainText("All day");

  // Collapse again; adding to the cart re-renders the menu and keeps it collapsed.
  await lunch.locator("summary").click();
  await expect(lunch.locator(".mealend")).toBeHidden();
  await expect(page.locator(".allday")).toBeVisible(); // labels the rest even with Lunch collapsed
  await card(page, "Edamame").getByRole("button", { name: "Add Edamame" }).click();
  await expect(card(page, "Edamame").locator(".step")).toBeVisible();
  expect(await lunch.evaluate((d) => d.open)).toBe(false);
  await page.locator("nav a", { hasText: "Maki" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Maki", exact: true })).toBeInViewport();
});

test("lunch items in the cart limit pickup to lunch times", async ({ page }) => {
  const json = menuJson({ lunch: true });
  await page.route("**/api/menu", (r) => r.fulfill({ json }));
  await page.goto("/");
  if (!(await page.locator("#g-lunch").evaluate((d) => d.open))) await page.locator("#g-lunch > summary").click();

  await card(page, "Edamame").getByRole("button", { name: "Add Edamame" }).click();
  await page.getByRole("button", { name: /View order/ }).click();
  await expect(page.locator("#lunchNote")).toBeHidden();
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.locator("#slot option")).toHaveCount(json.pickup.slots.length);
  await page.locator("#cartSheet [data-close]").click();

  await card(page, "Chicken Teriyaki").getByRole("button", { name: /Choose options/ }).click();
  await page.locator("#sheetAdd").click();
  await page.getByRole("button", { name: /View order/ }).click();
  await expect(page.locator("#lunchNote")).toHaveText("Your order has lunch-only items, so pickup is daily 11am–2:30pm.");
  const lunchSlots = json.pickup.slots.filter((s) => s.lunch);
  // ASAP only if it lands in lunch (depends on the real clock in this test).
  if (json.pickup.asap.lunch) await expect(page.locator("#tAsap")).toBeEnabled();
  else await expect(page.locator("#tAsap")).toBeDisabled();
  await expect(page.locator("#slot option")).toHaveCount(lunchSlots.length);
  expect(await page.locator("#slot option").evaluateAll((os) => os.map((o) => o.value))).toEqual(lunchSlots.map((s) => s.at));
});

test("back to top: appears after scrolling, sits above the order bar, returns to the top", async ({ page }) => {
  await page.goto("/");
  const top = page.getByRole("button", { name: "Back to top" });
  await expect(top).toBeHidden();
  await card(page, "Edamame").getByRole("button", { name: "Add Edamame" }).click();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(top).toBeVisible();
  const [t, b] = await Promise.all([top.boundingBox(), page.locator("#viewCart").boundingBox()]);
  expect(t.y + t.height).toBeLessThanOrEqual(b.y);
  await top.click();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(top).toBeHidden();
});
