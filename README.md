# Ginger: online pickup ordering

This is the pickup-ordering site for Ginger Japanese Restaurant in Bedford, MA. Customers:

1. browse the menu,
2. build a cart,
3. pay on Square's hosted checkout page (card, Apple Pay, Google Pay, optional tip).

The paid order then appears in Square Order Manager and prints in the kitchen.

**Square is the only source of truth.** Items, prices, options, sold-out status, photos, taxes, address, phone and hours all come from the Square catalog and location. There is no menu file in this repo and no admin app. Staff change everything in the Square Dashboard, and the site shows the change within about a minute.

## Architecture

```
public/index.html            Menu UI, item sheet, cart drawer, checkout (vanilla JS, no build step)
functions/api/menu.js        GET  /api/menu      -> normalized menu + pickup times
functions/api/checkout.js    POST /api/checkout  -> { url } of a Square-hosted checkout page
lib/square.js                Square fetch helper, catalog -> menu normalization, modifier rules,
                             validateLine(), hours, 60 s per-isolate cache
lib/pickup.js                Prep time, busy windows, last-pickup cutoffs, scheduled pickup slots
scripts/dump-catalog.mjs     Discovery: prints the catalog structure and warnings
test/                        node:test unit + function tests, Playwright e2e (test/e2e)
```

The stack is Cloudflare Pages plus Pages Functions. There are no runtime npm dependencies, and the Square REST API is called with `fetch`, not the SDK.

### Request flow

1. The browser loads `GET /api/menu`. The response holds the menu, restaurant info and the pickup options (ASAP and/or scheduled slots).
2. **Checkout** sends `POST /api/checkout` with only Square IDs, quantities, the name, the note and an optional `pickupAt`. The server:
   - re-checks every line against the menu, and returns `409` if anything is stale,
   - re-checks the pickup time,
   - calls Square `CreatePaymentLink` with an inline order.

   Square prices the order from its own catalog: no prices are sent, and taxes are applied automatically.
3. The customer pays on Square's page and is sent back to `SITE_URL/?status=success`.
   Payment methods on the checkout page: card, Apple Pay and Google Pay (per the seller's Square settings), and **Cash App Pay**. **Afterpay is off.** **ACH bank transfer is off** (`bank_account: false`): ACH settles days later, so the customer being sent back would not mean the order is paid, and Square turns ACH on by default for eligible sellers. Square's coupon and loyalty boxes are hidden (`enable_coupon: false`, `enable_loyalty: false`).
4. The order carries a **PICKUP fulfillment**, which is what makes Square send it to Order Manager / KDS and auto-print it. It is either `ASAP` or `SCHEDULED` with `pickup_at`.

### Square API version

Every request sends `Square-Version: 2026-11-18`, set as `SQUARE_VERSION` in `lib/square.js`. Before changing it, read Square's changelog for the Catalog, Orders and Checkout APIs.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `SQUARE_ACCESS_TOKEN` | yes | **Secret.** The app's access token. It uses `ITEMS_READ`, `MERCHANT_PROFILE_READ`, `ORDERS_READ`, `ORDERS_WRITE`, `PAYMENTS_WRITE`, but a personal access token carries the account's full permissions, so treat it like the owner's password |
| `SQUARE_LOCATION_ID` | yes | The Bedford location |
| `SQUARE_ENV` | yes | `sandbox` → connect.squareupsandbox.com, `production` → connect.squareup.com |
| `SITE_URL` | yes | No trailing slash. Used for the post-payment redirect |
| `HIDE_CATEGORIES` | | Comma-separated, case-insensitive. An item is hidden if **any** of its categories is listed. Currently `Cocktails,Wine,Sake,Beer` |
| `HIDE_MODIFIER_LISTS` | | Staff-only modifier lists, e.g. `Rush,Comp` |
| `HIDE_MODIFIERS` | | Staff-only single modifiers by name, case-insensitive. Currently the POS price keys `$1 Key,$1.5 Key,$2 Key,$3 Key`. Separator rows such as `---------` (items or modifiers with no letter or digit) are always hidden |
| `CATEGORY_ORDER` | | Display order; `*` = all other categories A–Z. Currently `Appetizers,*,Desserts,Drinks` |
| `PREP_TIME` | | ISO 8601 duration, default `PT20M` |
| `BUSY_PREP_TIME` | | Longer prep in busy windows, in the restaurant's time zone. Currently `FRI-SAT 17:00-19:00 PT30M`. Separate several rules with `;` |
| `PICKUP_CUTOFF` | | Minutes before each day's **final** close when the last pickup is offered. Currently `MON-THU:10,FRI-SAT:15,SUN:10`: last pickup 9:20pm Mon–Thu and Sun (close 9:30), 9:45pm Fri–Sat (close 10). Mid-day breaks have no cutoff (lunch ends 2:30) |
| `SCHEDULE_DAYS` | | Today plus the next N−1 days. Default `3` |

### Pickup rules

These are implemented in `lib/pickup.js`, and every rule has a test in `test/pickup.test.js`:

- **ASAP** is offered only if now + prep time falls before the last pickup of the current open period.
- **Scheduled slots** run every 15 minutes:
  - They start at the period's opening time (11:00, 12:00 on Sunday, 4:00).
  - They end at the last pickup time.
  - None is ever earlier than now + prep time.
- **Prep time** comes from the time the order is placed, for ASAP orders. A scheduled order gets the prep time of its pickup time, sent as `prep_time_duration`.
- **Re-checked at checkout:** the server rebuilds the slot list, and a time that's no longer offered returns 409.

## Local development

```sh
npm install
cp dev.vars.example .dev.vars      # fill in the Square values; .dev.vars is git-ignored
npm run dev                        # wrangler pages dev public -> http://localhost:8788
```

`wrangler pages dev` reads `.dev.vars` automatically. Use a **sandbox** token locally.

Discovery report (read-only, needs only `ITEMS_READ` and `MERCHANT_PROFILE_READ`):

```sh
node scripts/dump-catalog.mjs > catalog-report.txt
```

The report lists:
- categories with item counts
- every item with its sizes, prices, overrides and online visibility
- every modifier list with its limits, and which items use it
- the location's address, phone and hours
- warnings for things the site can't sell: no category, variable price, nested or TEXT modifiers, and required lists with no visible options

## Testing

```sh
npm test            # unit + function tests (node:test); Functions are bundled with esbuild first
npm run test:e2e    # Playwright against public/ with /api mocked from test/fixtures
npm run test:all
```

`test/fixtures/catalog.js` is one fake catalog that the unit, function and e2e tests all share.

`validateLine` exists twice, once in `lib/square.js` and once in `public/index.html`, because there's no build step. `test/validate.test.js` fails if the two copies drift apart.

## Deploy: Cloudflare Pages

1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**, then pick this repo and branch.
2. Build settings:
   - **Framework preset:** None
   - **Build command:** *(empty)*
   - **Build output directory:** `public`

   The `functions/` folder is picked up automatically.
3. **Settings → Variables and Secrets:**
   - Add `SQUARE_ACCESS_TOKEN` as type **Secret**.
   - Add the other variables as plain text.
   - Set them for **Production**, and for **Preview** with sandbox values.
4. **Settings → Runtime:** set a recent compatibility date.
5. **Custom domain:** buy the domain through Cloudflare Registrar, in the owner's account, then add it under **Custom domains**. Set `SITE_URL` to that domain and redeploy.

Changing a variable takes effect on the next deploy.

Vercel Hobby is not an option: its terms forbid commercial use.

## Square setup

### App and token

1. On developer.squareup.com, create an application ("Ginger Online Ordering").
2. The **Sandbox** tab gives you a sandbox access token and a sandbox location ID. The **Production** tab gives you the real ones, using the owner's account.
3. The site needs `ITEMS_READ`, `MERCHANT_PROFILE_READ`, `ORDERS_READ`, `ORDERS_WRITE` and `PAYMENTS_WRITE`. A personal access token can't be narrowed to these (only OAuth tokens have scopes): it has full access to the account. Only the person deploying should see it, and if it leaks, replace it on the Credentials page.
4. Store the token only in `.dev.vars` or as a Cloudflare Secret. Never commit it, paste it into chat, or put it in a URL.

### Seed the sandbox

The sandbox has its own, empty catalog. Open it from **Developer Dashboard → Sandbox test accounts → Square Dashboard**, then create:

- **Categories:** Appetizers, Maki, Desserts, and Sake (to check that hiding works).
- **Items:**
  - **Edamame:** one price, no options. Tests one-tap Add.
  - **California Roll:** two sizes (4 pc, 8 pc), with two modifier lists:
    - **Rice** (required, single choice: White, Brown +$1). Set it to require exactly 1.
    - **Toppings** (optional, up to 2: Eel sauce, Spicy mayo, Tobiko +$2).
  - **Mochi:** one price. Mark it sold out at the location to check the "Sold out" state.
  - **House Sake**, in the Sake category. It must **not** appear on the site.
- **Business hours** on the sandbox location, including a split day.
- **Sales tax** applied to the items.

Then run `node scripts/dump-catalog.mjs` and check that the report shows no unexpected warnings.

## Kitchen printer setup (Square POS)

1. On the POS device that drives the kitchen printer, go to **Settings → Hardware → Printers**.
2. Open the **kitchen printer profile** and turn on:
   - **Online & kiosk order tickets**
   - **Automatically print new orders**
3. Assign that profile to **only one device**. Otherwise every order prints once per device.

### Staff: completing orders

Square's docs say payment-link orders that carry a fulfillment **stay OPEN after payment and never complete on their own**. Staff mark each one Ready and then Completed in **Order Manager** (or on the KDS), as they do for other online orders.

API-created payment links are single-use, and they don't appear in the Dashboard's Payment Links list. The orders they create do appear in Order Manager.

## Go-live checklist (sandbox first, then one real order)

- [ ] The menu shows the right categories in the right order; no alcohol appears.
- [ ] Prices, photos, sold-out items, address, phone and hours match the Square Dashboard.
- [ ] Changing a price or sold-out status in Square shows on the site within about a minute.
- [ ] An **ASAP** order:
  - redirects to Square checkout, with tax and the tip option shown,
  - comes back to the thank-you banner,
  - appears in **Order Manager** with the right items, **modifiers**, name, note and pickup time,
  - **prints automatically** on the kitchen printer.
- [ ] The checkout page offers Cash App Pay and does **not** offer Afterpay or bank transfer (ACH), and shows no coupon or loyalty box. If Square rejects the link because the seller isn't eligible for Cash App Pay, the site shows "please call us" and logs the error; in that case remove `cash_app_pay` from `functions/api/checkout.js`.
- [ ] Staff can mark an online order Ready, then Completed, in Order Manager.
- [ ] A **scheduled** order (e.g. tomorrow 11:00am) appears as a scheduled pickup. **Note when it prints:** at payment, or near the pickup time.
- [ ] Ordering after the last pickup offers only scheduled times.
- [ ] On a phone (iOS Safari and Android Chrome): add items, use the options sheet, check out, and pay with Apple Pay / Google Pay.
- [ ] One real production order, then refund it in the Square Dashboard.

## Known limits

- **Nested modifiers** are not supported. If the nested option is in a required list, the whole item is hidden; otherwise only that option is hidden. The discovery report lists them.
- **The same modifier more than once** (e.g. 2× extra sauce) is not supported.
- **TEXT modifiers** (free-text fields) are skipped. Customers use the "Allergies or requests" note instead.
- **Variable-priced items** are hidden online.
- **Sold-out modifiers** are hidden. If that leaves a required list with no options, the item is hidden.
- **Pickup only.** Delivery fulfillments are limited to Square-certified partners.
- **Item-level min/max:** when an item sets only one of min/max on a modifier list, the other is read as "no requirement" / "no limit". Confirm on the POS that this matches its behaviour.
