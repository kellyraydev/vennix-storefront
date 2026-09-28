# Vennix — editorial storefront for Shopify

The Vennix storefront experience, with **Shopify as the commerce backend**.

One storefront experience, three parts with strictly separated jobs:

| Part | Where | Who owns what |
| --- | --- | --- |
| **Custom storefront** | `server.js`, `lib/`, `public/` | Presentation: renders the editorial theme (home, collections with server-side filtering/sorting, PDP with variant switching, cart drawer + page, journal, CMS pages, gift cards), and hands cart/checkout to Shopify. Captures non-commerce leads only (newsletter, contact, back-in-stock alerts, review submissions). |
| **Shopify** | configured via env | Source of truth for products, variants, prices, inventory, collections, pages, blog posts, carts, discount codes, customers, checkout, orders, payments, shipping and taxes. Talked to through the Storefront API (`lib/shopify/`). |
| **OS 2.0 theme** | `shopify-theme/` | The **production storefront** — hosted by Shopify, synced from this repo via *Deploy with Shopify* (GitHub integration on `main`). 32 sections, 12 snippets, JSON templates, locale file, mirrored motion layer. |

Production path: the theme is the published storefront; the Node app is an
alternative custom deploy of the same Shopify data (and the zero-credential
demo). Don't let both render the same domain. There is **no second commerce
database**. The retired custom JSON backend is
isolated in `legacy/` (see `legacy/README.md`) and is not loaded by anything.

---

## Quick start

```bash
node server.js          # demo mode — no credentials needed
```

With no `SHOPIFY_STORE_DOMAIN` configured the server boots an in-process
**mock Shopify gateway** (`tools/mock-shopify/gateway.js`) that serves the
committed fixture catalog (`data/fixtures/shopify-store.json`) through the
exact Storefront-API wire format, and the UI carries a visible *Demo mode*
banner. Same code path as production — different endpoint.

To run against your store:

```bash
export SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
export SHOPIFY_STOREFRONT_ACCESS_TOKEN=shpat_…   # Storefront API token
node server.js

# …then prove it end to end against your store:
npm run verify:live
```

Credentials can also live in a git-ignored `.env` — the server loads `.env`
and `.env.local` on boot (the real process environment always wins).

Full instructions: [`docs/SETUP.md`](docs/SETUP.md). Env reference:
[`.env.example`](.env.example). Migration plan and rationale:
[`docs/MIGRATION.md`](docs/MIGRATION.md).

---

## Storefront highlights (all kept from the original experience)

- Editorial home: hero, trust bar, store pulse (honest counters from real
  catalog + review data), category grid, spotlight, brand story, testimonials,
  journal teasers, lookbook, newsletter.
- Collections with server-side faceted filtering (category, colour, size,
  type, availability, price), 7 sort modes, active-filter chips, load-more +
  crawler-friendly pagination, plus a virtual `sale` collection computed from
  real compare-at pricing.
- Predictive search over products, collections, pages and journal articles;
  remembered recent searches (local only).
- Product pages: variant switching live-updates price, compare-at, savings,
  stock messaging, gallery and sticky purchase bar; JSON-LD `Product` schema
  with `aggregateRating` **only when real reviews exist**.
- Cart drawer + cart page with free-shipping progress (storefront brand
  promise), gift notes and order notes (carried into the Shopify cart note),
  quantity steppers, upsell rail.
- Checkout is Shopify's: `/checkout` 302-redirects to the Shopify-hosted
  checkout URL; buy-now goes straight there. Shipping, taxes, payment,
  confirmation and tracking all live with Shopify.
- Accounts: the storefront links through to Shopify customer accounts; the
  wishlist stays a client-side (localStorage) feature.
- **Monogramming** as a real Shopify service product (`monogramming`, hidden
  from the catalog): server-validated characters, live re-priced add button,
  added as a paired cart line with `Monogram` attributes, merged for display,
  kept in sync on update/remove.
- **Size finder** (`lib/fit.js`): measurement bands + cut + preference →
  sized recommendation with reasoning and confidence.
- **Shop the look** (`lib/style.js`): Shopify `productRecommendations`
  augmented with studio pairing rules; add-the-whole-look in one request; no
  invented bundle discounts.
- **Back-in-stock alerts**: sold-out sizes stay selectable; alerts refuse
  in-stock sizes; uniform responses prevent email enumeration.
- Motion layer (`public/js/motion.js`): scroll reveals, parallax, counters,
  fly-to-cart, ticker, progress bar — all off under `prefers-reduced-motion`.
- SEO/a11y: semantic markup, keyboard navigable overlays, canonical URLs,
  sitemap from the live catalog, alt text, lazy loading.

---

## Where each concern lives

| Concern | Location |
| --- | --- |
| Routes, security headers, CSP nonces, CSRF, rate limiting, compression, caching, sitemap/robots | `server.js`, `lib/security.js`, `lib/compress.js`, `lib/ratelimit.js` |
| Per-cart serialisation (no lost updates on double-add) | `lib/locks.js` |
| Graceful 503/500 pages that never need Shopify | `lib/pages/status.js` |
| Shopify GraphQL client + operations + normalization (cents, images, metafields) | `lib/shopify/{config,client,operations,normalize}.js` |
| Cached catalog facade (products, collections, pages, articles, search, recommendations) | `lib/shopify/catalog.js` |
| Shopify cart mutations | `lib/shopify/cart-api.js` |
| Cart orchestration (cookie, monogram pairing, line merging, display) | `lib/cart.js` |
| JSON endpoints used by the client layer | `lib/api.js` |
| Pages / layout / components | `lib/pages/`, `lib/layout.js`, `lib/ui.js` |
| Presentation rules (fit, monogram, styling) | `lib/fit.js`, `lib/personalize.js`, `lib/style.js` |
| Brand settings (no commerce state) | `config/storefront.json`, `lib/settings.js`, `lib/money.js` |
| Non-commerce lead capture | `lib/leads.js` → `data/leads.json` |
| Client layer (no framework) | `public/js/main.js`, `public/js/motion.js`, `public/css/main.css` |
| Demo fixture + generator | `data/fixtures/shopify-store.json`, `scripts/build-fixtures.js` |
| Mock Storefront API (demo/CI only) | `tools/mock-shopify/gateway.js` |
| OS 2.0 theme | `shopify-theme/` |

---

## Verification

```bash
npm run verify
```

| Suite | What it proves |
| --- | --- |
| `npm run check` | every live module loads cleanly |
| `npm run test:shopify` | Shopify data layer (192 assertions) against the mock gateway: config guards, checkout-URL allowlist, cookie/CSRF helpers, pinned-document hygiene, schema-conformance logic, normalization, catalog reads, search, recommendations, all cart mutations, inventory rules, discount validation, concurrency |
| `npm run doctor` | configuration and deployment sanity (no network): mode, API version, proxy, CSP, canonical domain, repo hygiene |
| `npm run secrets` | no credential can reach a browser — static scan of every shipped file, plus a runtime crawl with a fake token in the environment |
| `npm run check:render` | 27 page shapes render without crash markers, self-boots the server |
| `npm run theme:check` | the OS 2.0 theme's Liquid/JSON/i18n/settings parity |
| `npm run smoke` | 118 HTTP end-to-end assertions: pages, cart API, checkout handoff, leads, CSP nonces, CSRF tokens, rate limits (incl. per-visitor throttling behind a proxy), static-file containment, output encoding, cookie flags, compression, ETag/304, SEO payloads, health telemetry |
| `npm run features` | 45 feature-rule assertions: monogramming, size finder, shop-the-look, alerts, filtering/sorting/load-more, free-shipping promise |
| `npm run links` | dead-link crawl over every internal href |
| `npm run a11y` | 130 accessibility assertions over rendered HTML: landmarks, heading order, alt text, control labelling, dialogs, live regions |
| `npm run browser:test` | 62 real-DOM click assertions (jsdom, dev-only dep): variant switching, add-to-cart, drawer, quick view, discount forms, motion layer, monogram UI, size finder, look bundle, alerts, search memory |
| `npm run verify:live` | **against your real store**: schema conformance (every field and argument we send must exist on 2026-07), products, prices, inventory, collections, search, recommendations, cart mutations, discount validation, checkout handoff, Shopify-owned accounts/orders, no local commerce store, live pages with no demo banner |

`browser:test` needs jsdom once: `npm install --no-save jsdom` (or in
`/tmp/jsdom` — the script finds it there). CI installs it automatically, and in
CI a missing jsdom **fails** the run — a suite that did not run is not a pass.

---

## Notes

- Inventory shown on product pages comes from Shopify (the Storefront API
  inventory scope). Overselling is refused by Shopify carts, and the
  storefront re-checks stock on every add.
- Money is integer cents end-to-end; Shopify `MoneyV2` is converted at the
  normalization edge.
- Catalog reads are cached for ~15s (`SHOPIFY_CACHE_TTL_MS`) so page fan-out
  doesn't hammer the API; carts are never cached. If Shopify goes quiet the
  last good catalog is served for up to five minutes, then a branded 503 with
  `Retry-After` takes over.
- Security defaults: nonce-based CSP (per request), SameSite=Lax + `Secure`
  cookies, double-submit CSRF tokens, per-IP per-route rate limits, Shopify-only
  checkout redirects, and zero secrets in client code (proven by `npm run
  secrets`). See `AUDIT.md` for the full production-readiness audit.
- The custom admin is retired: `/admin` returns a pointer to the Shopify
  admin, where products, orders, customers and discounts are managed.
