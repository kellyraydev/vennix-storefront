# Setup — running the Vennix storefront with Shopify

The storefront is a zero-dependency Node app that renders the editorial
experience and reads/writes commerce through the **Shopify Storefront API**.
There are three ways to run it:

1. **Demo mode** — no Shopify store needed (mock gateway + fixture catalog)
2. **Against your store** — read-only catalog + Shopify carts/checkout
3. **Theme-only** — deploy `shopify-theme/` to Shopify Online Store 2.0

---

## 1. Demo mode (default, no credentials)

```bash
node server.js
# [vennix] DEMO MODE — no SHOPIFY_STORE_DOMAIN configured.
# [vennix] Mock Shopify gateway on ephemeral port; using fixture catalog.
```

What happens:

- `tools/mock-shopify/gateway.js` boots on an ephemeral port and serves
  `data/fixtures/shopify-store.json` through the exact GraphQL operations the
  storefront uses (products, collections, search, recommendations, cart
  mutations, checkout URLs).
- The storefront talks to it with the same `lib/shopify/client.js` code path
  as production — demo mode swaps the endpoint, not the code.
- The UI shows a *Demo mode* banner. Carts, discounts (`WELCOME10`,
  `FREESHIP`, `CAPSULE20`), oversell rules and the monogram service product
  all behave like a real store.

Regenerate the fixture after changing `scripts/build-fixtures.js`:

```bash
npm run fixtures
```

> The fixture is a **development visual fixture**, not production data. It is
> never written to a real Shopify store, and real-store data is never
> overwritten by this repo.

---

## 2. Connecting your Shopify store

### a. Create a Storefront API token

In the Shopify admin of your store:

1. **Settings → Apps and sales channels → Develop apps** (enable custom app
   development if prompted).
2. Create an app (e.g. *vennix-storefront*).
3. Under **Configuration → Storefront API access scopes**, grant:
   - `unauthenticated_read_product_listings`
   - `unauthenticated_read_product_inventory`
   - `unauthenticated_write_checkouts`
4. Install the app and copy the **Storefront API access token**.

Nothing else is required: the storefront reads the published catalog and
operates carts; checkout, payments, shipping, taxes, orders and customers are
all Shopify-hosted.

### b. Configure the environment

```bash
export SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
export SHOPIFY_STOREFRONT_ACCESS_TOKEN=…
# optional
export SHOPIFY_PRIMARY_DOMAIN=www.yourbrand.com   # canonical domain
export SHOPIFY_API_VERSION=2026-07
node server.js
# [vennix] Live mode — catalog and carts come from your-store.myshopify.com (Storefront API 2026-07).
# [vennix] Connection preflight:
#   ✓ shop — Your Store Name
#   ✓ products (unauthenticated_read_product_listings) — 12 products visible
#   ✓ inventory (unauthenticated_read_product_inventory) — variant stock readable (8)
#   ✓ cart + checkout (unauthenticated_write_checkouts) — cartCreate accepted
#   ✓ pages + journal (unauthenticated_read_content) — pages query accepted
```

Or copy `.env.example` to `.env` (git-ignored) and fill it in — the server
loads `.env` and `.env.local` itself (`.env.local` wins), and the real process
environment always wins over both. See `.env.example` for the full reference.
**Never commit tokens.**

The server refuses to start in demo mode when `NODE_ENV=production`, and
refuses to start at all when the Storefront API cannot be reached with the
credentials you supplied. A misconfigured deploy fails loudly at boot instead
of quietly serving an empty catalogue.

### c. What the storefront uses from your store, as-is

- Published products + variants (the hidden `vennix-service`-tagged
  monogram product is treated as the monogram fee; it is filtered from the
  catalog but can be added as a paired cart line).
- Collections (nav + collection pages are generated from them; a virtual
  `sale` collection is computed from compare-at pricing).
- Pages (`/pages/:handle`) and the blog `journal` (`/blogs/journal`).
- Product `reviews` metafield (from any reviews app) — rendered as-is;
  `aggregateRating` is emitted only when reviews exist.
- Discount codes are validated by Shopify carts — the storefront never keeps
  its own list.

> The storefront **does not write to your catalog**. It never creates or
> mutates products, prices, inventory or content.

### d. Monogramming (optional)

If you sell a monogram/embroidery add-on, create a published product
(handle `monogramming`, tag `vennix-service`, price = the fee). The storefront
detects it and charges monograms as a real second cart line. Without it, the
monogram UI degrades to a free-note mode and stops quoting a fee.

### e. Checkout handoff

- `GET/POST /checkout` → 302/303 to `cart.checkoutUrl` (Shopify-hosted).
- `/api/buy-now` returns the checkout URL for the client.
- Order confirmation, tracking and account pages point customers to Shopify
  (confirmation email / `/account` on the store). `/track` explains this;
  legacy `/orders/:number` URLs get a helpful pointer page.

---

## 3. Deploying the OS 2.0 theme (the production storefront)

`shopify-theme/` is a complete Online Store 2.0 theme and the **canonical
production storefront** — hosted by Shopify itself, synced from this repo.

### a. GitHub Sync (recommended): "Deploy with Shopify"

Shopify's first-party GitHub integration deploys the theme on every push —
no server, no CLI, no secrets in the repo:

1. Shopify admin → **Online Store → Themes → Deploy with Shopify →
   Set up your repository**.
2. Authorise Shopify's GitHub app for this repository
   (`kellyraydev/vennix-storefront`). It is scoped to this repo and only
   reads theme files from it.
3. Configure the sync: branch **`main`**, path to theme files
   **`shopify-theme`**, and a target theme. Point it at an **unpublished**
   theme to stage and publish manually, or at the **published** theme for
   live updates on every merge.
4. Every push to `main` deploys to the connected theme within ~1 minute.
   Verify the first sync by touching any theme file (even a comment in
   `assets/theme.css`) and watching it appear in the theme editor.

CI runs `npm run theme:check` (inside `npm run verify`) on every push and
PR, so a structurally broken theme fails in GitHub before it can be
published.

### b. Shopify CLI / tag workflow (fallback)

```bash
cd shopify-theme
shopify theme dev --store your-store.myshopify.com     # live preview
shopify theme push --store your-store.myshopify.com    # upload
```

…or use the included workflow: **Actions → Deploy Shopify theme** (push a
`v*` tag, or run it manually; needs the `SHOPIFY_STORE`,
`SHOPIFY_CLI_THEME_TOKEN`, optional `SHOPIFY_THEME_ID` secrets). Use it when
the GitHub app isn't installed. The theme is self-contained and works
without the Node storefront.

**Ownership rule:** the theme is the production front door (Shopify-hosted).
The Node storefront (`server.js`) is an alternative custom deploy of the
same Shopify data — don't let both render the same domain.

---

## Production hosting notes

- Bind `HOST=0.0.0.0`, put TLS termination in front, set `NODE_ENV=production`
  (cookies become `Secure`, HSTS is sent, demo mode is refused).
- **Behind a reverse proxy, forwarded headers must be trusted exactly once.**
  `TRUST_PROXY=1` turns trust on; `TRUST_PROXY=0` forces it off; unset, the
  app auto-detects platform proxies (Vercel, Render, Fly.io, Railway). With
  trust on, the client address comes from `x-real-ip` or the **rightmost**
  `X-Forwarded-For` hop — never the client-forgeable first entry — and it is
  the single answer shared by the rate limiter, the cart-burst session key and
  `X-Forwarded-Proto` (so cookies go `Secure`). With trust off on a proxied
  deploy, every visitor shares one rate-limit bucket (900 req/min for the whole
  deployment) — `npm run doctor` errors on exactly that combination.
- `PUBLIC_SITE_DOMAIN` should match the public hostname for canonical URLs;
  the sitemap is generated live from the Shopify catalog.
- Cookies: with `NODE_ENV=production` (or a trusted proxy plus
  `X-Forwarded-Proto: https`) the cart and CSRF cookies are `Secure`. In
  production they also carry the `__Host-` prefix, so no subdomain can set or
  shadow them; set `COOKIE_HOST_PREFIX=off` if you ever need the plain names,
  and `VENNIX_FORCE_INSECURE_COOKIES=1` only for a plain-http host you control.
- The catalog cache (`SHOPIFY_CACHE_TTL_MS`, default 15s) keeps page fan-out
  cheap; carts are always read fresh. On a Shopify outage the last good
  catalog is served for up to five minutes before the 503 page takes over.
- Local state is limited to non-commerce leads in `data/leads.json`
  (newsletter, contact messages, back-in-stock alerts, review submissions for
  moderation). Mount that path on persistent storage (or set `LEADS_DIR`) if
  you need the captures to survive deploys, or wire `lib/leads.js` to your own
  sink. **On read-only deployment filesystems (e.g. Vercel functions) the file
  cannot be written at all**: the capture is still accepted and answered with a
  thank-you, but the record is dropped — `/healthz` reports
  `leads.writable: false` and a `leads.writeFailures` count, boot logs a
  warning, and `npm run doctor` errors on it in production. Point `LEADS_DIR`
  at writable persistent storage before relying on any capture.
- **Serverless (Vercel via `api/index.js` + `vercel.json`)**: the catalog
  cache, the rate limiter and the cart-burst locks are per process, so each
  function instance has its own — expect weaker per-IP throttling across
  instances and no cross-instance single-flight (Shopify stays authoritative
  either way). A failed Shopify preflight is retried at most once every
  `VENNIX_INIT_RETRY_MS` (default 5s) instead of per request.

### What ships switched on

| Area | Behaviour |
| --- | --- |
| CSP | Nonce-based, enforced (`CSP_MODE=report-only` to observe first) |
| Cookies | `Secure` under TLS, `HttpOnly` cart id, `SameSite=Lax`, `__Host-` prefixed in production |
| CSRF | SameSite=Lax cookies + Origin check + double-submit `vnx_csrf` token |
| Rate limits | Per-IP, per-route (tight on discount codes, forms and reviews) |
| Transport | HSTS, nosniff, referrer-policy, COOP, permissions-policy, frame-deny |
| Compression | brotli → gzip for HTML/CSS/JS, ETag + 304 for static assets |
| Checkout | Only Shopify hosts are allowed to receive the handoff |
| Failure states | Branded 503 with `Retry-After` for Shopify outages, 500 otherwise — never a stack trace |

---

## Verification

```bash
npm install --no-save jsdom     # dev-only, for the browser click test
npm run verify                  # everything below, start to finish
npm run doctor                  # configuration only, no network
npm run verify:live             # prove a REAL store is wired up end to end
```

`npm run verify` runs: module load check → Shopify data-layer suite (mock
gateway) → configuration doctor → secret scan (static + runtime) → render
check → theme structure check → HTTP smoke → feature suite → link crawl →
accessibility check → browser click test. Every suite that needs a server
boots its own throwaway instance, so they can be run in any order, twice in a
row, without inheriting state. CI runs the same pipeline on every push
(`.github/workflows/verify.yml`).

`npm run verify:live` is the one to run after you set real credentials. It
introspects your store's schema first and confirms every field and argument the
pinned documents send exists on 2026-07 (that is what catches
`Field 'x' doesn't accept argument 'y'` before a shopper does), then
boots the storefront against your store and proves, in order: live products,
live variants/prices, live inventory, live collections, live search, live
recommendations, cart mutations (create/add/update/note/remove), discount
codes validated by Shopify, a checkout URL that passes the Shopify-only
allowlist, account/order URLs that point at Shopify, no local order/payment/
customer store anywhere in the runtime path, and real pages served with live
data and no demo banner. It creates one throwaway draft cart on your store —
never an order, customer or payment.

```bash
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com \
SHOPIFY_STOREFRONT_ACCESS_TOKEN=… \
VENNIX_LIVE_DISCOUNT_CODE=WELCOME10 \
npm run verify:live
```
