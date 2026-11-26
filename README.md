# Ginger: online pickup ordering

Cloudflare Pages site plus Pages Functions. The menu comes from the Square catalog, and payment happens on Square's hosted checkout. Full docs come in Phase 5.

## Discovery (Phase 0)

```sh
cp dev.vars.example .dev.vars   # fill in SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENV
node scripts/dump-catalog.mjs > catalog-report.txt
```

The report only reads data. It needs the token scopes `ITEMS_READ` and `MERCHANT_PROFILE_READ`.

## Square API version

Every request sends `Square-Version: 2026-08-19`, set as `SQUARE_VERSION` in `lib/square.js`.
