import { test, expect } from "@playwright/test";
import { normalizeMenu } from "../../lib/square.js";
import { pickupOptions, pickupSettings } from "../../lib/pickup.js";
import { objects, location, env } from "../fixtures/catalog.js";

// Menu as /api/menu would return it; open all day so ASAP is available whenever the test runs.
function menuJson({ requiredRice = true } = {}) {
  const warn = console.warn;
  console.warn = () => {}; // the fixture's excluded items are expected
  const { menu } = normalizeMenu(objects, location, env);
  console.warn = warn;
  const m = structuredClone(menu);
  if (requiredRice) for (const c of m.categories) for (const it of c.items) for (const l of it.modifierLists) {
    if (l.name === "Rice") l.modifiers.forEach((x) => (x.default = false));
  }
  const allDay = { timezone: "America/New_York", business_hours: { periods: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    .map((d) => ({ day_of_week: d, start_local_time: "00:00", end_local_time: "23:59" })) } };
  return { ...m, restaurant: { ...m.restaurant, today: "FRI" }, pickup: pickupOptions(allDay, pickupSettings(env)) };
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
  await expect(page.getByRole("link", { name: "(781) 555-0100" })).toHaveAttribute("href", "tel:+17815550100");
  const hours = page.locator("#rHours");
  await expect(hours.locator("summary")).toHaveText("Today 11am – 2:30pm, then 4pm – 10pmAll hours");
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
  await card(page, "California Roll").getByRole("button", { name: /Choose options/ }).click();
  const sheet = page.locator("#itemSheet");
  await expect(sheet.getByRole("radio", { name: /4 pc/ })).toBeDisabled();
  await expect(sheet.getByRole("radio", { name: /8 pc/ })).toBeChecked();
  const add = sheet.locator("#sheetAdd");
  await expect(add).toBeDisabled();
  await expect(add).toHaveText("Make required choices");
  // Defaults: Eel + Spicy checked (max 2), so Tobiko is locked.
  await expect(sheet.getByRole("checkbox", { name: /Tobiko/ })).toBeDisabled();
  await sheet.getByText("Brown rice").click();
  await expect(add).toHaveText("Add · $11.00"); // 9.00 + 1.00 + 0.50 + 0.50
  await sheet.getByRole("button", { name: "Increase quantity" }).click();
  await expect(add).toHaveText("Add · $22.00");
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

test("cart persists; ?status=success clears it and cleans the URL", async ({ page }) => {
  await page.goto("/");
  await card(page, "Edamame").getByRole("button", { name: "Add Edamame" }).click();
  await page.reload();
  await expect(page.locator("#bar")).toContainText("1 item");
  await page.goto("/?status=success");
  await expect(page.locator("#topMsg")).toContainText("Thank you");
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
