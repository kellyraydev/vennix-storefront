# Vennix Storefront — Audit Report

> **Three audits live in this file.**
>
> 1. **[Production-readiness audit — 2026-09-28](#production-readiness-audit--2026-09-28)** — the
>    current one: re-verifies every claim of the previous audit against the
>    code as it stands (including the new Vercel entry point), finds the places
>    where the claims were true on a laptop and false in production, and fixes
>    them with regression tests.
> 2. **[Production-readiness audit — 2026-09-23](#production-readiness-audit--2026-09-23)** — the
>    previous full pass: security, caching, failure states, mobile, SEO, a11y
>    and performance for the storefront (Shopify = commerce backend, this repo
>    = presentation). Every finding re-checked on 2026-09-28; see §0 of the
>    current audit for what still holds and what did not.
> 3. **[Historical audit — 2026-09-21](#historical-audit--2026-09-21-pre-shopify-migration)** — the
>    original review of the retired custom commerce backend. Kept for the
>    record; every finding in it was either fixed at the time or made moot by
>    moving products, carts, checkout, orders and customers into Shopify.

---

<a name="production-readiness-audit--2026-09-28"></a>
# Production-readiness audit — 2026-09-28

Scope: the whole shipped surface — `server.js`, `lib/`, `public/`, `scripts/`,
`api/index.js`, `vercel.json`, the workflows — on branch
`arena/01a0e597-vennix-storefront`, Node v22.22.3 locally, `nodejs24.x` on
Vercel, Shopify Storefront API 2026-07. Nothing had changed in `lib/` since the
2026-09-23 audit except the Vercel entry point (`api/index.js`, `vercel.json`,
`vercelHandler`) — and that entry point is exactly where this pass found the
previous audit's assumptions broken.

Method: re-run the whole suite (`npm run verify` — green, but the browser test
was **silently skipped** without jsdom, reported below), then attack every
"✅ Hardened" claim with an adversarial reproduction of the environment it
would be deployed into. Four claims broke; each fix below landed with an
automated assertion so it cannot regress. All suites now: **192**
data-layer · **118** smoke · **62** browser · **45** feature · **130** a11y ·
**9** secret-scan · 27 rendered pages · 43 crawled pages · 13 theme checks ·
doctor 14 ok / 0 errors.

## Scoreboard

| # | Area | Status before | Status after | What changed |
| --- | --- | --- | --- | --- |
| 1 | Rate limiting behind a proxy | ❌ **Broken in production** | ✅ Fixed + proven | shared-bucket collapse and XFF spoofing fixed; per-visitor throttling asserted behind a live proxied server |
| 2 | Cart-burst session key | ❌ **Collision behind a proxy** | ✅ Fixed + proven | key now uses the real client IP; an unidentifiable visitor matches no one |
| 3 | Lead capture durability | ❌ **Silently lost on serverless** | ✅ Reported + gated | write failures counted on `/healthz`, boot warning, doctor error |
| 4 | Vercel entry point wiring | ❌ **Broken 3 ways** | ✅ Fixed + gated | runtime matches engines, cold-start storm tamed, state caveat documented and checked |
| 5 | Static file containment | ⚠️ Fragile | ✅ Hardened | prefix check → real containment; `%2e%2e` decoded; hard 404s carry nosniff |
| 6 | CI: engines vs runtime | ⚠️ Contradicted | ✅ Aligned | `engines: >=20`; matrix on 20.x + 24.x; live job on the shipping runtime; a skipped browser test fails CI |
| 7 | Refusal responses | ⚠️ Inconsistent | ✅ Hardened | every 4xx/429 carries nosniff + framing deny; `Retry-After` on serverless init 503s |
| 8 | The other twelve 2026-09-23 claims | ✅ | ✅ Re-verified | CSRF, cookies, XSS/CSP, checkout allowlist, locking, caching, API errors, failure pages, mobile, SEO, a11y, performance — all still hold; see §0 |

---

## 0. Re-verification of the 2026-09-23 audit

Every claim was re-tested, not re-read. Result: the twelve claims about the
*code* hold. The claims about the *deployment environment* did not — a lesson
this audit's fixes encode as checks:

- **CSRF, cookies, checkout allowlist, XSS/CSP, escaping** — all assertions
  still pass; no regression found.
- **Inventory races / locking** — `withLock` still serialises per cart. But the
  *session→cart memory* that prevents parallel first-add orphaning keyed on the
  raw socket address — broken behind any proxy (finding §2).
- **Rate limiting** — the limiter itself is fine; its *key* was the raw socket
  address, which behind a proxy is one address for everybody (finding §1).
- **Caching, compression, ETag/304, SEO, a11y, mobile, failure pages** — all
  re-verified by the suites, unchanged.
- **"Verified by `npm run verify`"** — the fine print lied in one place:
  `browser:test` exits 0 with `jsdom not installed — skipping`. CI installed
  jsdom, so the workflow was honest; a laptop `npm run verify` was not. A skip
  is now loud locally and **fails in CI**, and this audit's run includes the
  previously-skipped 62 browser assertions.

---

## 1. Rate limiting collapsed to one bucket per deployment (Critical in production)

**Found:** `lib/ratelimit.js` keyed buckets on `req.socket.remoteAddress`
unless `TRUST_PROXY=1`. On the Vercel entry point (and any platform proxy) the
socket address is the platform's — identical for every visitor. Proven: 950
distinct visitors, one request each → **50 of them 429'd** by the global
900/min limiter; with the contact form (3 per 10 min) the **4th visitor
site-wide** is refused. Worse, with `TRUST_PROXY=1` the code took the
**leftmost** `X-Forwarded-For` entry — the one header a client fully controls.
Proven: one attacker sending `X-Forwarded-For: <random>, <real>` made **100 of
100** discount-code guesses land in fresh buckets (limit: 10/min). An
unauthenticated, enumerable guessing surface with no effective limit.

**Fixed** (`lib/auth.js`, one `clientIp()` used by the limiter, the session key
and `security.js`):

- Trust is a single decision: `TRUST_PROXY=1` on, `0` off, unset → auto-detect
  platform proxies (Vercel, Render, Fly.io, Railway) — the platforms whose edge
  always fronts every request. A bare `node server.js` still trusts nothing.
- Behind a proxy: `x-real-ip` first (the platform overwrites it; a client
  cannot), else the **rightmost** `X-Forwarded-For` hop (what an appending
  proxy puts last = the real client), else the socket.
- No proxy trusted: the socket address, and a client-supplied header changes
  nothing.

**Verified by:** `scripts/test-shopify.js` ("Client identity, proxy trust and
rate limiting" — 18 assertions incl. the forged-first-hop case), and
`scripts/smoke.js` boots a **second live server with `TRUST_PROXY=1`** and
proves six visitors keep separate allowances, a seventh is unaffected, one
visitor over the limit is refused, and a forged first hop buys nothing.

## 2. Two strangers could share one cart-burst session (High)

**Found:** `lib/locks.js` `sessionKey()` hashed the raw socket IP + user-agent
+ per-tab id. Behind a proxy, the IP term was constant, so two visitors with a
common user-agent and no `vnx_sid` (curl, prefetchers, privacy browsers, first
paint) hashed to the **same key** — reproduced with Chrome/140 on Windows.
Whoever's add ran first had their brand-new cart id remembered for the other
visitor (750 ms–2 s): the second visitor's items land in the first visitor's
cart. Also, with `TRUST_PROXY=1` the limiter saw forwarded IPs while the lock
still saw the socket — the two halves of the same feature disagreed about who
the visitor was.

**Fixed:** the key uses the shared `clientIp()`; and a request that cannot be
distinguished at all (no sid, unknown IP) returns `null`, which creates a fresh
cart — the worst case is an orphaned cart, never a shared one. (The old code
also treated the literal string `"undefined"` as an IP; gone.)

**Verified by:** `scripts/test-shopify.js` ("two visitors behind one proxy no
longer share a cart-burst key", "an unidentifiable visitor is never matched to
someone else's cart").

## 3. Lead captures were silently dropped on read-only filesystems (High on serverless)

**Found:** reproduced on a read-only `LEADS_DIR`: `insert()` returned success,
the shopper got the thank-you, the write failed in a debounced timer, the only
trace was an unstructured `console.error`, and nothing — not the API response,
not `/healthz`, not the doctor — reported it. On Vercel's read-only functions
**every newsletter signup, contact message, review and back-in-stock request
would be accepted and lost, invisibly**.

**Fixed** (`lib/leads.js`): durability is now reportable — `stats()` exposes
`writable`, `writeFailures`, `lastError`, `lastWriteAt` and is surfaced on
`/healthz` (`leads`), boot warns once per minute with the remedy, `saveNow()`
returns a boolean, and `npm run doctor` **errors** on an unwritable sink in
production. The shopper never sees a 500 — a lead that cannot persist must not
break the page — but it can no longer fail silently.

**Verified by:** `scripts/test-shopify.js` ("Lead capture durability" — runs a
child process against a read-only directory and asserts the failure is
returned, counted and flagged), smoke asserts `/healthz` reports a healthy sink
honestly.

## 4. The Vercel entry point was broken three ways (High for the deploy it was added for)

The last commit before this audit added `api/index.js` + `vercel.json` with no
test, no doctor coverage and no documentation. Checking it found:

1. **Runtime contradiction** — `vercel.json` pins `nodejs24.x` while
   `package.json` declared `engines: "24.x"` yet CI verified on Node 20. The
   shipped runtime was the one runtime nothing ever tested. Fixed: engines
   widened to the real floor (`>=20`), CI now runs the offline suites on a
   **20.x + 24.x matrix**, `verify:live` runs on 24.x (the shipping runtime),
   and the doctor errors if `vercel.json`'s runtime ever disagrees with the
   manifest again.
2. **Cold-start retry storm** — `vercelHandler` re-ran `initialize()` on every
   request after a failure; with Shopify unreachable each request repeats DNS +
   preflight + backoff retries inside the function's time budget, multiplying
   the outage. Fixed: a failed init is remembered for `VENNIX_INIT_RETRY_MS`
   (default 5 s) and answered immediately with a 503 that carries
   `Retry-After`.
3. **Undocumented state model** — the catalog cache, limiter and locks are per
   process; on Vercel every instance has its own. That is acceptable (Shopify
   stays authoritative; throttling is merely weaker), but it was nowhere
   written down. Now documented in `docs/SETUP.md`, `.env.example`, printed as
   a doctor warning on detected platforms, and `/healthz` exposes
   `proxy.trustForwardedHeaders` + which platform was detected.

Also added to the doctor: `vercel.json` rewrites must keep excluding `/api`
(the one path that must not be double-routed).

## 5. Static file containment was one refactor away from a path traversal (Medium)

**Found:** the guard was
`path.normalize(pathname)…; path.join(PUBLIC_DIR, safe); startsWith(PUBLIC_DIR)`
— the classic prefix check, which accepts a sibling `public-evil/`, and it
never percent-decoded, so `%2e%2e%2f` sailed through `normalize` untouched
(encoders differ on whether the router decodes first; nothing here guaranteed
it). Not exploitable as shipped (Node's router does not decode), but one
routing change away from serving `server.js`, `.env` or the fixture to anyone.

**Fixed:** decode explicitly (bad encoding → 400), resolve, then verify with
`path.relative` — containment by real path math, not a string prefix. Static
404s now carry `nosniff` instead of a bare 404 that sniffed as text.

**Verified by:** `scripts/smoke.js` ("Static file containment") — six escape
payloads (`%2e%2e` variants, NUL, sibling-prefix) must serve nothing outside
`public/` while real and encoded-but-legitimate assets still serve.

## 6. Cross-cutting hardening (Low)

- **Every refusal hardened**: `refuse()` and both 429 paths (server + API) now
  carry `X-Content-Type-Options: nosniff`, framing deny and referrer policy;
  the serverless-init 503 carries `Retry-After`. (`lib/api.js`'s 429 was the
  one response in the app with no nosniff.)
- **`X-Forwarded-Proto` is only read when the proxy is trusted** in
  `vercelHandler` too (it previously believed the header unconditionally when
  building the request URL).
- **CI honesty**: a skipped browser test warns locally and **fails in CI**
  (`CI=true` or `VENNIX_REQUIRE_BROWSER_TEST=1`) — a suite that did not run can
  no longer masquerade as a pass. This audit's run is the first to include the
  62 browser assertions.
- **Engines tell the truth**: `>=20` matches what the suites actually prove.

## Residual risks (honest list, replacing the 2026-09-23 one)

1. **Serverless state is per instance** (cache, limiter, locks). Single-host
   deploys are unaffected; on Vercel expect weaker cross-instance throttling.
   Shopify stays authoritative for cart/checkout either way.
2. **Leads still land on local disk by default** — but an unwritable or
   non-persistent sink is now *visible* (`/healthz`, boot warning, doctor
   error) instead of silent. Wire `lib/leads.js` to a real sink before you
   market off the list.
3. **Auto-detected proxy trust assumes the platform sanitises forwarded
   headers.** Vercel/Render/Fly/Railway do (and overwrite `x-real-ip`); that is
   why auto-trust is limited to them and why the rightmost XFF hop — not the
   client-chosen first one — is read. On exotic proxies, set `TRUST_PROXY`
   explicitly.
4. **Rate limiting is still in-process.** Fine for one instance; multi-host
   needs sticky sessions or a proxy limiter (unchanged from the last audit).
5. **The catalog cache can still be 15 s stale** on price/stock display; cart
   and checkout are always live (unchanged).
6. **CSP still allows inline `style` attributes** for the design-system custom
   properties (unchanged).
7. **Device testing on real hardware** is still on the human list (unchanged).

---

<a name="production-readiness-audit--2026-09-23"></a>
# Production-readiness audit — 2026-09-23

Scope: the Node storefront (`server.js`, `lib/`, `public/`) as the production
front end for an existing Shopify store. Date: 2026-09-23. Branch:
`arena/01a0cdc7-vennix-storefront`. Node 22 (project floor now `>=20` — see the
2026-09-28 audit §4). Shopify Storefront API **2026-07** (current stable,
supported until 2027-07-16).

> **Read together with the [2026-09-28 audit](#production-readiness-audit--2026-09-28).**
> Everything in this section was re-verified there. Four findings did not
> survive contact with a proxy-fronted deployment: the rate-limit *key* (§4
> below — one shared bucket behind a platform proxy, and the forgeable first
> XFF hop was trusted), the cart-burst *session key* (§7 — strangers could
> collide behind a proxy), "verified by `npm run verify`" (the browser test
> could silently skip), and lead durability (§10/§12 — unwritable sinks were
> silent). All fixed on 2026-09-28 with regression tests; the text below is
> kept as written.

Method: read every module in the request path, then convert each conclusion
into an automated assertion so it cannot silently regress. Every "status"
below links to a check that runs in `npm run verify` (or `npm run verify:live`
for the ones that need a real store).

## Scoreboard

| # | Area | Status | What it rests on |
| --- | --- | --- | --- |
| 1 | Authentication / session security | ✅ Strong | No local auth at all — Shopify owns customer identity; the only cookie is an opaque cart id |
| 2 | CSRF | ✅ Hardened | SameSite=Lax + Origin/Referer + per-session double-submit token; contact form carries a field token |
| 3 | Cookies | ✅ Hardened | Cart id `HttpOnly` + `SameSite=Lax` + `Secure` (prod *or* `X-Forwarded-Proto: https` behind a proxy); stale cart cookies are expired |
| 4 | Rate limiting | ✅ Hardened | Per-IP, per-route sliding windows; tight on discount codes and forms; `Retry-After` on every 429 |
| 5 | XSS | ✅ Hardened | Nonce-based CSP enforced per request + escaping audit + payload regression tests |
| 6 | Checkout handoff | ✅ Hardened | Shopify-host allowlist before any redirect; 303 on POST; no open-redirect path |
| 7 | Inventory races | ✅ Hardened | Per-cart serialisation, burst-scoped cart memory, Shopify is authoritative, friendly stock errors |
| 8 | Caching | ✅ Hardened | Bounded 15s catalog cache with stale-on-error; ETag + 304 + long-lived immutable assets; HTML `private, no-store` |
| 9 | Shopify API errors | ✅ Hardened | Typed errors, bounded retry with backoff and `Retry-After`, no retry on auth failures, metrics on `/healthz` |
| 10 | Graceful failure | ✅ Hardened | Branded 503 with `Retry-After` for Shopify outages, 500 otherwise, never a stack trace |
| 11 | Mobile UX | ✅ Audited + fixed | 16px inputs on small screens (no iOS zoom), 44px hit areas, safe-area insets |
| 12 | SEO | ✅ Audited | Canonical/og/twitter/JSON-LD, live sitemap, `noindex` on cart/search/checkout/account/track |
| 13 | Accessibility | ✅ Audited + fixed | 130 automated assertions; heading order, alt text, labelling, dialogs, live regions |
| 14 | Performance | ✅ Improved | brotli/gzip (~7× smaller HTML, ~5× smaller CSS/JS), ETag/304, preconnect to `cdn.shopify.com`, LCP `fetchpriority` |

---

## 1. Authentication / session security

**Status: strong by architecture.** There is no local login, no password, no
session table, no customer record and no payment record anywhere in this
repository. Customer identity, order history and addresses live behind
Shopify's own customer accounts; `/account`, `/account/login`,
`/account/orders` and `/account/addresses` link (or 302) to the store's
Shopify-hosted account URL. The retired admin (`/admin`) returns a pointer to
the Shopify admin.

The only value the storefront keeps per visitor is the **Shopify cart id**, in
an `HttpOnly` cookie. It is not an identity: it grants nothing but access to a
cart Shopify already owns, and it is validated by Shopify on every read.

Verified by: `scripts/verify-live.js` §11 (accounts point at Shopify), §12 (no
local customer/order store), `scripts/smoke.js` (cart-cookie flags).

## 2. CSRF

Three independent layers, because state-changing requests (cart mutations,
leads, reviews) are the whole point of the site:

1. **SameSite=Lax cookies** — a cross-site POST never carries them.
2. **Origin/Referer check** (`sameOrigin()` in `server.js`) on every non-GET.
3. **Double-submit token** — `lib/security.js` mints a 256-bit `vnx_csrf`
   cookie per session; `public/js/main.js` echoes it in `X-CSRF-Token`, server
   compares with `timingSafeEqual`. Server-rendered forms (contact) carry a
   hidden `_csrf` field instead.

A browser session always has the cookie, so a cross-site POST — which cannot
*read* the cookie — is refused with 403. Non-browser clients with no cookie
fall through to the Origin check, so curl and webhooks keep working.

Verified by: `scripts/smoke.js` ("a POST without the token header is refused",
"the same POST with the token is accepted", "cross-origin POST is blocked"),
`scripts/test-shopify.js` (CSRF helper unit tests).

## 3. Cookies

| Cookie | Flags | Purpose |
| --- | --- | --- |
| `vnx_cart` | `HttpOnly`, `SameSite=Lax`, `Secure` when TLS, `Path=/`, 60 days | Shopify cart id, server-side only |
| `vnx_csrf` | readable by page JS (double-submit needs it), `SameSite=Lax`, `Secure` when TLS, 12 hours | CSRF token — an unguessable value, not an identity |
| `vnx_sid` | readable, `SameSite=Lax`, per tab | Correlates the parallel requests of one click-burst |

`Secure` is set when `NODE_ENV=production` **or** when `TRUST_PROXY=1` and
`X-Forwarded-Proto: https` — so a TLS-terminating proxy no longer silently
downgrades cookies to plain HTTP. Cookies are appended, never overwritten (the
old `Set-Cookie` clobbering bug stays fixed).

When Shopify no longer knows the cart in the cookie (checked out, expired,
abandoned), the cookie is expired on that response so the next add starts
clean instead of 404-ing Shopify forever.

Verified by: `scripts/smoke.js` ("the cart cookie is HttpOnly/SameSite=Lax"),
`scripts/test-shopify.js` (Secure-cookie matrix), `scripts/verify-live.js`.

## 4. Rate limiting

`lib/ratelimit.js` (in-memory sliding window, per IP) plus a per-route table in
`lib/api.js`:

| Route group | Limit | Why |
| --- | --- | --- |
| cart add / update / remove | 45–60 / min | generous but bounded |
| **discount apply** | **10 / min** | discount-code guessing is the one enumerable surface |
| newsletter | 6 / min | subscription spam |
| contact form | 3 / 10 min | human inbox |
| review submit | 3 / 10 min | moderation queue |
| back-in-stock alert | 12 / min | email target |
| search / quickview / fit / monogram | 30–90 / min | catalog-cache protection |
| any write | 120 / 10 s | global backstop |
| any request | 900 / min | process backstop |

Every rejection carries `Retry-After`. Behind a proxy, set `TRUST_PROXY=1` so
the key is `X-Forwarded-For` and not the proxy's own address (the doctor warns
when it is unset).

**Known limit:** single process. Multi-instance deploys need sticky sessions
or a shared limiter — Shopify stays authoritative regardless.

Verified by: `scripts/smoke.js` ("a flood of submissions is throttled",
"the 429 says when to retry").

## 5. XSS

- **Enforced, nonce-based CSP** on every HTML response (per-request nonce via
  `AsyncLocalStorage`; every inline `<script>` in the codebase carries it).
  `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
  `form-action 'self'`. Inline `style` attributes stay allowed — the design
  system sets per-element CSS custom properties (swatch colours, stagger
  indices, progress widths) and CSP has no nonce mechanism for attributes.
  `CSP_MODE=report-only` ships the same policy without enforcement if you want
  to watch for violations first.
- **Escaping**: every interpolation in `lib/ui.js`, `lib/layout.js` and
  `lib/pages/*` goes through `esc()`/`attr()`.
- **Regression tests**: `<script>` and attribute-breakout payloads are sent
  through reflected (search) and stored (contact, reviews, newsletter,
  back-in-stock) paths and asserted escaped.
- **Historical**: the search-overlay DOM XSS from the 2026-09-21 audit is fixed
  and covered.

Verified by: `scripts/smoke.js` (nonce coverage on every inline script, output
encoding), `scripts/secret-scan.js` (no client code touches the token).

## 6. Checkout handoff

`/checkout` and `/api/buy-now` never redirect to a URL they have not
allowlisted. `security.isAllowedCheckoutUrl()` requires `https:` and a host on
the store's own domain, the primary domain, `*.myshopify.com`,
`*.shopify.com`, `checkout.shopify.com`, or an explicit
`SHOPIFY_CHECKOUT_HOSTS` list. Anything else is logged and refused, so a
tampered or unexpected cart payload cannot turn this route into an open
redirect. POST uses 303 (so the follow-up is a GET).

Verified by: `scripts/test-shopify.js` (allowlist unit tests),
`scripts/smoke.js` (302 to a Shopify URL), `scripts/verify-live.js` §10.

## 7. Inventory race conditions

- **Shopify is the authority.** Every add goes through `cartLinesAdd/Update`,
  and Shopify refuses oversell with a `userError` the storefront surfaces as
  "Only N left in that size — lower the quantity to continue."
- **Lost updates are prevented locally.** The add flow is read-modify-write
  (read cart → merge lines → write). `lib/locks.js` serialises it per cart, so
  two taps on "add" cannot both read quantity 1 and both write 2.
- **Parallel first-time adds share one cart.** The cart cookie only exists on
  the *response*, so `lib/locks.js` remembers a just-created cart id for
  at most **2 seconds** (750 ms without the per-tab id) — long enough for one
  click-burst, far too short for two different visitors behind the same NAT to
  inherit each other's carts.
- Cached stock can be up to `SHOPIFY_CACHE_TTL_MS` (15 s) old on a product
  page; the cart and checkout always re-check with Shopify.
- Whether an oversell is refused at add time is the store's own inventory
  policy, not our code: Shopify rejects the line when a variant is set to
  *deny* overselling, and accepts it (reconciling at checkout) when it is set
  to continue selling. `npm run verify:live` reports which behaviour the store
  has instead of asserting one.

Verified by: `scripts/test-shopify.js` (concurrency, session-key isolation),
`scripts/verify-live.js` (oversell refused, sold-out refused).

## 8. Caching

| Layer | Policy |
| --- | --- |
| HTML | `Cache-Control: private, no-store`, `Vary: Cookie, Accept-Encoding` — the CSP nonce is per request and the cart count is per visitor |
| Catalog (Shopify reads) | bounded map, 15 s TTL, single-flight per key, stale-on-error up to 5 min, `cacheStats()` on `/healthz` |
| CSS / JS | `public, max-age=300, must-revalidate` + ETag → cheap deploys |
| Images | `public, max-age=604800, must-revalidate` + ETag |
| Sitemap / robots | `public, max-age=600` / `3600` |
| API (`/api/*`) | `no-store` |
| Compressed bodies | in-memory cache of the brotli/gzip result, bounded at 64 entries |

Nothing about price or stock is decided from cache: Shopify re-prices every
cart and every checkout.

Verified by: `scripts/smoke.js` (ETag, 304, HTML cache policy),
`scripts/test-shopify.js` (cache hit/miss/invalidate).

## 9. Shopify API errors

`lib/shopify/client.js` classifies every failure into a typed
`ShopifyError.code` (`auth`, `throttle`, `network`, `timeout`, `server`,
`graphql`, `not_found`, `bad_response`):

- 429 / `THROTTLED` → waits `Retry-After` (bounded at 15 s) and retries, with
  jittered backoff, up to 2 retries.
- 5xx / network / timeout → jittered backoff retry.
- 401 / 403 → **no retry**, with an actionable message naming the token and the
  Storefront API integration.
- GraphQL `errors` → surfaced verbatim; mutation `userErrors` → surfaced as a
  shopper-facing message.
- Counters (requests, errors, retries, throttles, last error) are exposed on
  `/healthz` for alerting. No token ever appears in a response.

At boot, `lib/shopify/preflight.js` proves each required scope before the
server accepts traffic, and **refuses to start** if the store cannot be read.

Verified by: `scripts/test-shopify.js` (error codes, retryability),
`scripts/verify-live.js` §2 (preflight) and §3 (schema conformance — the
documents are checked against the store's own introspection, so a renamed field
or dropped argument fails the run instead of failing at checkout).

**Pinned-document drift is a real risk** — a version bump can drop a field, drop
an argument, or tighten nullability. 2026-07 alone removed `types` from
`Product.media`, renamed `Article.body` to `contentHtml` (and deprecated
`Article.author` in favour of `authorV2`), made `Cart.discountApplications` a
plain list rather than a connection (no `first`, no `nodes`), and made
`cartNoteUpdate(note:)` and `cartDiscountCodesUpdate(discountCodes:)` non-null —
a nullable variable for a non-null argument is rejected with *"Nullability
mismatch"* before the mutation runs. Normalizers keep the storefront's own field
names (`body`, `author`) so templates never change when Shopify renames
something. Guards:
`scripts/verify-live.js` §3 introspects the live schema, and
`scripts/test-shopify.js` both greps the documents for known-rejected arguments
and unit-tests the conformance checker against stubbed schemas.

## 10. Graceful failure states

- **Shopify unreachable / throttled / credentials rejected** → branded 503 with
  `Retry-After: 30`, "The store is catching its breath", a retry button and the
  support address. Nothing internal, no stack trace.
- **Our bug** → branded 500, logged server-side, no detail to the visitor.
- **Cart failures** → JSON `{ ok: false, error }` with translated copy
  ("That piece just sold out…"), and the UI keeps the last known cart.
- **Empty / no results** states exist for cart, search, filters, wishlist and
  reviews (verified in the feature suite).

Verified by: `scripts/smoke.js`, `lib/pages/status.js`,
`scripts/verify-live.js`.

## 11. Mobile UX

Audited the responsive layer (breakpoints at 1100 / 900 / 620 px) and fixed
what was genuinely broken:

- **iOS zoom on focus**: form controls are 16 px on small screens
  (13–13.5 px inputs used to trigger Safari's auto-zoom).
- **Tap targets**: `.icon-btn`, `.qty button`, `.size`, `.swatch--lg` and
  `.cart-line__remove` now have ≥44 px hit areas — grown with padding and
  pseudo-element insets, so nothing looks different.
- **Home-indicator overlap**: `env(safe-area-inset-bottom)` padding on the
  cart drawer, mobile menu, footer and toast stack.
- Already sound: viewport allows zoom, 2-column product grid at 620 px,
  sticky ATC collapses to a column, horizontal rails use scroll-snap, motion
  is off under `prefers-reduced-motion`.

Not a substitute for device testing — worth one pass on a real iPhone and a
mid-range Android.

## 12. SEO

- Canonical, `og:*`, `twitter:card`, `theme-color`, JSON-LD
  (`Organization`, `WebSite`, `Product`, `FAQPage`, `BreadcrumbList`) — all
  present and generated from live Shopify data.
- `sitemap.xml` is built from the live catalog (products, collections, pages,
  journal) with `lastmod`; `robots.txt` points at it and blocks
  `/checkout`, `/cart`, `/account`, `/api/`.
- `noindex,follow` on internal search, cart, checkout, track, account and 404 —
  thin and personal pages stay out of the index while their links are still
  followed.
- `<img>` always carries `alt` + intrinsic `width`/`height` (no CLS); product
  cards lazy-load; the hero is `fetchpriority="high"`.
- **Before launch**: set `PUBLIC_SITE_DOMAIN` to the real hostname so
  canonicals and the sitemap use it (`npm run doctor` warns while it is unset
  or a placeholder).

## 13. Accessibility

130 automated assertions over rendered HTML (`npm run a11y`) across ten page
types: one `<main>`, one `<h1>`, no skipped heading levels, `lang` + zoomable
viewport, skip link, `alt` on every image, an accessible name on every control
and button, labelled dialogs, `aria-live` for async updates, no `tabindex="-1"`
outside the skip target.

Fixed during this audit: heading-order skips on the collection, size-guide and
account pages (visually-hidden `h2`s — no visual change), and the accessible
names of unlabelled controls.

Still requires a human pass: screen-reader narration of the cart drawer and
quick view, and a contrast check on any new brand palette.

## 14. Performance

Measured on the home page (brotli vs identity):

| Asset | Raw | On the wire |
| --- | --- | --- |
| HTML (home) | 99,976 B | 12,776 B (br) / 13,705 B (gzip) |
| `main.css` | 99,322 B | 20,025 B |
| `main.js` | 58,148 B | 14,625 B |

Zero dependencies: compression uses `node:zlib` (brotli → gzip → deflate,
chosen from `Accept-Encoding`), with `Vary: Accept-Encoding` and a bounded
cache of compressed static bodies. Static responses carry ETag + 304. In live
mode the head preconnects to `https://cdn.shopify.com`. Catalog reads are
cached 15 s with single-flight, so a page render costs one Shopify round trip,
not one per component. Server keeps connections alive (65 s) with a 30 s
request timeout.

## Residual risks (honest list)

1. **Rate limiting is per process.** Run one instance, use sticky sessions, or
   put a limiter in the proxy.
2. **Cart-burst memory is per process** for the same reason; the worst case is
   an extra Shopify cart, never a wrong order.
3. **Leads live on local disk** (`data/leads.json`). Non-commerce, but mount
   persistent storage or swap `lib/leads.js` for Klaviyo / your review app.
4. **The catalog cache can be 15 s stale** on price/stock display. Cart and
   checkout are always live. Lower `SHOPIFY_CACHE_TTL_MS` if you sell
   one-of-one items.
5. **CSP still allows inline `style` attributes** (design-system custom
   properties). Moving swatch colours into a nonce'd `<style>` block would let
   you drop `'unsafe-inline'` from `style-src`.
6. **No request logging / tracing yet** beyond console errors and `/healthz`
   counters. Add your platform's log drain and alert on
   `/healthz` → `shopify.lastError`.
7. **Device testing**: the mobile fixes are reasoned and automated-checked, not
   yet hand-verified on hardware.

---

<a name="historical-audit--2026-09-21-pre-shopify-migration"></a>
# Historical audit — 2026-09-21 (pre-Shopify migration)

*Kept for the record. This reviewed the retired custom commerce backend;
products, carts, checkout, orders, payments and customers now live in Shopify,
which removed most of these findings at the root. The retired code is isolated
in `legacy/` and is loaded by nothing.*

---


Date: 2026-09-21
Branch: `arena/01a0c182-vennix-storefront`
Base commit: `0623e3b` ("Add files via upload")
Node: v22.22.3 (project requires `>=18`)

## Fixes applied in this session

The Critical / High issues listed in this report were fixed directly. Verifying
with `npm run check && npm run smoke && npm run features && npm run links && npm
run theme:check` — **119/119 smoke, 41/41 features, 43 pages OK, 13/13 theme
checks pass**. A summary of the changes:

| Fix | Files |
|---|---|
| Missing source restored (zip extracted into tree; zip deleted from repo) | `lib/`, `public/`, `scripts/`, `shopify-theme/`, `data/`, `docs/`, `.github/`, `seo/` |
| `.gitignore` expanded to cover corrupt-DB backups, temp files, `.env` | `.gitignore` |
| `Set-Cookie` overwrite bug fixed (now uses array + append, so session + cart cookies both land) | `lib/auth.js`, `lib/cart.js` |
| Session/cart cookies now `Secure` under `NODE_ENV=production`, `SameSite=Lax`, `HttpOnly` (cart was previously readable from JS) | `lib/auth.js`, `lib/cart.js` |
| Security headers added (`X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options`) on both HTML and JSON responses | `server.js` |
| CSRF defense via `Origin`/`Referer` check on every non-GET request (covers `/api/*`, `/admin/*`, and form POSTs). Cross-origin POSTs return 403. | `server.js` |
| Password-reset email now links to `/account/reset?token=…` (was `/account/reset/<token>` → 404) | `lib/emails.js` |
| Password reset links now enforce the one-hour `resetExpires`, invalidate on use, and wipe existing customer sessions after reset | `server.js` |
| Admin credentials: no longer pre-filled in the HTML; `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars supported; auto-generated one-time password printed to stdout on first boot when running in `NODE_ENV=production` without a password; boot banner no longer prints the password | `lib/seed.js`, `lib/admin/router.js`, `server.js` |
| Admin login rate-limited (8 attempts/min/IP) | `lib/admin/router.js` |
| Storefront login and order-tracking endpoints rate-limited | `server.js` |
| DOM XSS in the search overlay fixed (user query escaped before `.innerHTML`) | `public/js/main.js` |
| Checkout idempotency — a hidden `_checkoutToken` ties a successful order to the cart, so refresh/back-button resubmits redirect to the existing order instead of charging twice | `server.js`, `lib/pages/checkout.js` |
| Payment sandbox now refuses real PANs: only the documented test cards are approved when `settings.payments.testMode` is true (prevents "paid" orders from being created against numbers that look real) | `lib/commerce.js` |
| Email shell now uses `settings.address` and `settings.supportEmail` instead of the hardcoded Vennix/Brooklyn address — rebranding works end-to-end | `lib/commerce.js` |
| Unknown US states no longer silently default to 6% tax (they now show "Tax (XX) — not configured" with a 0% rate so the merchant can add the correct rate instead of over-charging) | `lib/commerce.js` |
| Boot banner no longer prints "(sandbox) (sandbox)" twice | `lib/seed.js`, `server.js` |

Items still outstanding (not fixed here, see §7 for full list): a proper
per-form CSRF token (the Origin check gives solid baseline protection but a
synchronizer token is stricter), full CSP and HSTS (infrastructure-dependent),
non-sequential public order IDs, cache-busted asset filenames, splitting
`lib/admin/router.js`, a production process manager / Dockerfile, and locking
down the CI jsdom install with a pinned devDependency.


## Executive Summary

The repository as checked into Git is **not runnable**. The initial commit
`0623e3b` only contains top-level files (`server.js`, `package.json`,
`README.md`, `brand.example.json`, `LICENSE`, `.gitignore`,
`.gitattributes`) plus an uploaded binary `vennix-storefront (1).zip`
(3.1 MB) that holds the actual source tree (`lib/`, `public/`, `scripts/`,
`shopify-theme/`, `data/`, `docs/`, `.github/`, `seo/`). `npm start` as
cloned crashes with `MODULE_NOT_FOUND` for every `require('./lib/...')`
in `server.js`. After extracting the zip, `npm run check`, `npm run smoke`
(119/119), `npm run features` (41/41), `npm run links` (43 pages, 0
broken) and `npm run theme:check` (13/13) all pass — but several real
security, correctness and repository-hygiene issues remain.

**Severity key:** 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low · ℹ️ Info

---

## 1. Repository hygiene

| Sev | Issue | Evidence |
|---|---|---|
| 🔴 | **Missing source from the working tree — `npm start` fails on a fresh clone.** Only the root files are committed; every `require('./lib/...')` in `server.js` (lines 13–30) fails. The actual code lives only inside the un-ignored zip `vennix-storefront (1).zip`. | `find . -not -path '*/.git/*'` returns 8 files + zip before extraction. |
| 🔴 | **A 3.1 MB vendor zip is committed to the repo.** `vennix-storefront (1).zip` is not in `.gitignore` and duplicates the rest of the codebase as a binary blob. This will bloat the Git history permanently once pushed. | `ls -la "vennix-storefront (1).zip"` → 3,297,043 bytes. |
| 🟠 | **Runtime data is not actually ignored.** `.gitignore` lists `data/db.json` and `data/emails/`, but the committed tree had no `data/` directory at all. Once seeded, running `git add .` would pick up `data/db.json`, `data/emails/*.html`, and a directory that is not in any branch baseline. Additionally, nothing ignores the `data/db.*.corrupt-*.json` files that `lib/store.js` writes when the DB is unreadable (line 43 of `lib/store.js`). | `.gitignore` lines 2–3; `lib/store.js:43`. |
| 🟠 | **`seo/` directory exists but is neither documented nor ignored.** It contains a Python script, CSVs of meta descriptions, and a REVIEW.md. The README makes no mention of it; it looks like an artifact of an SEO pass that was shipped by accident. | `ls seo/` → `README.md  REVIEW.md  build-meta-descriptions.py  meta-descriptions-audit.csv  meta-descriptions-deploy.csv`. |
| 🟡 | **`package.json` points at placeholder repo URLs.** `repository.url`, `bugs.url` and `homepage` all reference `https://github.com/your-org/vennix-storefront` rather than `Kellyray-dev/vennix-storefront`. | `package.json:33–40`. |
| 🟡 | **CI only runs on `push` to `main` and on PRs.** Branch pushes (e.g. to `arena/...`) won't trigger `verify.yml` because of `branches: [main]`. | `.github/workflows/verify.yml:3–5`. |
| ℹ️ | **`npm test` is not defined.** The README advertises `npm run verify`, which is fine, but tools that assume `npm test` will fail. | `package.json` scripts. |
| ℹ️ | **`brand.example.json` shows the "Northline" example, not Vennix.** README tells the user to copy it and edit, but the example is a different brand and the `_comment`/`_noPhone`/`_socials` noise keys will be picked up by naive JSON consumers. | `brand.example.json`. |

---

## 2. Security

### 2.1 🔴 Hardcoded admin credentials

`lib/seed.js` seeds the admin account with a fixed email and password:

```js
admin: { email: 'admin@vennixstore.com' },
...
const adminCreds = auth.hashPassword('vennix123');
db.settings.admin.passwordHash = adminCreds.hash;
```

The login form (lib/admin/router.js:889-893) **pre-fills** the password
field with `vennix123`, and the server logs the credentials on boot:

```
Admin  http://localhost:3000/admin  (admin@vennixstore.com / vennix123)
```

These credentials are never rotated: there is no first-run password
change, no env-var override, and no generated secret. Anyone who can
reach the deployed server gets the admin panel on the first try.

**Fix:** Read admin email/password from `process.env.ADMIN_EMAIL` /
`process.env.ADMIN_PASSWORD` (with a random one-time password printed to
stdout if unset in production), force a password change on first login,
and remove the value from the `<input value="vennix123">` autocomplete.

### 2.2 🟠 No CSRF protection on state-changing routes

Every POST endpoint — checkout, account updates, admin order actions
(fulfil, refund, cancel, product/discount/settings saves), cart
mutations, contact, newsletter, reviews — accepts
`application/x-www-form-urlencoded` or JSON bodies with no CSRF token,
no `Origin`/`Referer` check, and no double-submit cookie. The session
cookie is `SameSite=Lax`, which mitigates cross-site form submits in
modern browsers for most endpoints, **but not** for top-level POST
navigations (e.g. a third-party site submitting to `/checkout` or
`/admin/...`) and not at all for older browsers / API calls made with
credentials.

Examples:
- `server.js:433` `/checkout` POST creates a paid order.
- `lib/admin/router.js` `/admin/orders/:id/fulfil`, `/refund`,
  `/cancel`, `/admin/products/save`, `/admin/discounts/save`,
  `/admin/settings/save` all take form posts without a token.
- `lib/api.js` accepts JSON POSTs without requiring any header that a
  cross-origin script cannot force (no `X-Requested-With` or custom
  token check).

**Fix:** Add a per-session CSRF token, render it into every form and
require it for POST (and for any non-idempotent API route). For API
endpoints, reject non-JSON content-types or require a custom header.

### 2.3 🟠 Cookie handling is broken — `Set-Cookie` gets overwritten

Node's `res.setHeader('Set-Cookie', …)` **replaces** any existing
`Set-Cookie` header instead of appending. `lib/auth.js` and `lib/cart.js`
both use `setHeader`:

```js
// lib/auth.js:65
res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, id, ...));
// lib/cart.js:27
res.setHeader('Set-Cookie', auth.serializeCookie(CART_COOKIE, id, ...));
```

On any response that sets both (e.g. first-hit add-to-cart when a new
cart is created AND the session is simultaneously issued — or a
register-then-add flow where the cart ID is freshly allocated), **only
one cookie survives**. Verified empirically with curl:

```
POST /account/register ... → Set-Cookie: vnx_sid=...   (cart cookie lost)
```

Because the cart cookie is also client-readable (`httpOnly: false`,
see 2.4) and the session is 30 days, the observable symptom is "my cart
occasionally empties on sign-in/up". More importantly any future code
that sets a second cookie (e.g. a `Set-Cookie` on a flash message) will
silently nuke the session.

**Fix:** Always use `res.appendHeader('Set-Cookie', …)` (Node ≥ 18) or
build an array and call `setHeader('Set-Cookie', arrayOfCookies)`.

### 2.4 🟠 Session cookie is missing `Secure` and partitioned flags; cart cookie is readable from JS

`serializeCookie` in `lib/auth.js:57-61` emits `HttpOnly`, `Path=/` and
`SameSite=Lax` but never adds `Secure`, so cookies are sent over
plaintext HTTP in production (there is no TLS redirect). The cart
cookie is explicitly set `httpOnly: false` (lib/cart.js:27), so XSS can
steal cart IDs and tie them to visitor sessions. There is no
`__Host-` prefix and no `SameSite=Strict` option for admin sessions.

**Fix:**
- Add `Secure` when `NODE_ENV === 'production'`.
- Consider `SameSite=Strict` for `/admin/*` (or a separate admin cookie
  scope).
- Make the cart cookie `HttpOnly` (the client JS doesn't need to read
  it — it already talks to the server via `/api/cart/*`).

### 2.5 🟠 No brute-force / rate-limit / lockout on auth endpoints

`/admin/login`, `/account/login`, `/account/recover`, `/api/*` (cart
add, notify, newsletter, reviews, contact) have no rate limiting and no
CAPTCHA. `admin.login_failed` is logged but never throttled, so a
credential-stuffing attack on the publicly-documented admin account is
unbounded. The demo password `vennix123` is in the HTML source of the
login page, trivially scannable.

### 2.6 🟠 DOM XSS in client-side search "nothing matched"

In `public/js/main.js:202`:

```js
searchResults.innerHTML = html || '<p class="sr-empty">Nothing matched "' + q + '". Try … </p>';
```

`q` is read straight from the `<input>` via an on-input keystroke
handler and inserted as HTML. A search term like
`<img src=x onerror=alert(1)>` fires in the visitor's own browser. The
server-rendered `/search` page correctly uses `ui.esc(q)` — the bug is
only on the live-search overlay, but it is a real reflected/self XSS
that can be triggered by a crafted `#q=...` URL if the query is seeded
from the URL (need to confirm; at minimum typing HTML into the search
box pops an alert).

The "cart drawer" and quickview HTML also use `.innerHTML = h.drawer`,
`.innerHTML = res.html` but those come from the server which HTML-escapes
user fields. The search empty-state is the only confirmed sink I found
using raw client-side strings.

**Fix:** Replace the literal `q` with `esc` on the client, or set that
text via `textContent`.

### 2.7 🟠 Password-reset token is never expired server-side

`server.js:513` writes `resetExpires: now + 36e5` (one hour), but the
verification at `server.js:521` checks only `c.resetToken === body.token`
— it never consults `resetExpires`. An old reset link works forever
until the token is overwritten by a new reset request.

Additionally, the reset link emailed by `lib/emails.js:85` points to
`/account/reset/${token}` (a path segment), but the server only registers
`/account/reset` and reads `?token=` from the query string
(server.js:395-398). The emailed link 404s — **the reset flow is broken
out of the box**. The in-app flash notice (`/account/reset?token=...`)
works, but actual email recipients cannot reset their password.

**Fix:**
1. Check `resetExpires` in the POST handler.
2. Invalidate `resetToken` after use (it is set to `null`, good — but
   also invalidate any session created before the reset).
3. Change the email URL to
   `https://${settings.domain}/account/reset?token=${encodeURIComponent(token)}`
   (or add a matching `/account/reset/:token` GET route).

### 2.8 🟠 Order-lookup endpoint is trivially enumerable

`server.js:371-377`:

```js
/orders/([A-Za-z0-9\-]+)
...
const emailOk = !order || !order.email ||
  (query.email || '').toLowerCase() === order.email;
```

Order numbers are sequential (`VEN-1001`, `VEN-1002`, … — see
`createOrder` in `server.js`). The email check is case-insensitive but
there is no rate limit or constant-time comparison, so an attacker who
knows a customer's email can walk every order they've placed (and
because order numbering is predictable and starts at 1001, email
confirmation of any single order leaks the entire sequence).

**Fix:** Use non-sequential order identifiers in URLs (e.g. a random
`publicId`) or add an HMAC signature over the order id + email; rate
limit `/orders/*` and `/track`.

### 2.9 🟡 Missing security headers

The only security-related header emitted is
`Referrer-Policy: strict-origin-when-cross-origin` and
`X-Content-Type-Options: nosniff`, both only on HTML responses
(server.js:51-53). Missing:

- `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`) — the admin
  can be clickjacked.
- `Content-Security-Policy` — none at all, so the XSS in §2.6 runs
  inline.
- `Strict-Transport-Security` — no HSTS, no TLS redirect in-app.
- `Permissions-Policy` — nothing set.
- `X-XSS-Protection: 0` (to disable the deprecated redundant filter
  that can introduce issues).

### 2.10 🟡 Payment flow accepts any Luhn-valid card (including real PANs)

`lib/commerce.js:authorize` approves any card that passes Luhn + expiry
+ CVV + name, except the seven explicit test-card numbers. Entering a
real live card number will show a successful order ("paid",
`authCode`, `last4`, "live-sandbox" network). The order is recorded as
paid, the stock is decremented and a confirmation email is written —
even though there is no real processor. That's fine for a demo, but
nothing warns a production deployer:

- `settings.payments.testMode` exists but is never checked before
  authorizing.
- There is no webhook/capture step, no idempotency key, and
  double-submit of the checkout POST will create multiple orders
  (e.g. a user refreshing the POST response).

**Fix:** Gate `authorize` on `settings.payments.testMode === true`, and
require an idempotency key or short-lived checkout token for POST
`/checkout`.

### 2.11 🔵 Demo customer password seeded in plaintext

Seed data creates `hannah.b@example.com / password123`
(lib/seed.js:683, and README "Demo accounts"). Harmless for a seed, but
document it as "do not deploy without changing".

### 2.12 🔵 HTML-injection potential from brand/settings strings

Most templates use `ui.esc()` for user-generated content, but several
bits of `settings` (brand name, social URLs, announcement bar copy, tagline)
are interpolated without escaping on the assumption they come from the
admin. The admin settings form does not validate that e.g.
`settings.brandName` doesn't contain `</script><script>…`. Since admin
already has HTML-injection capability this is not a privilege
escalation, but a defense-in-depth fix would `esc()` settings values at
the view layer too.

---

## 3. Correctness / functional bugs

| Sev | Issue | Location |
|---|---|---|
| 🟠 | **Password-reset email link is broken (404).** Email uses `/account/reset/<token>` path; server only handles `/account/reset?token=`. Recovery links sent to customers dead-end. | `lib/emails.js:85` vs `server.js:395`. |
| 🟠 | **Password-reset tokens never expire.** `resetExpires` is written but never read. | `server.js:520-527`. |
| 🟠 | **Checkout double-submit creates duplicate paid orders.** No idempotency / no post-redirect-get PRG on POST `/checkout` — a refresh or back-button resubmits the form and charges/captures again. The stock re-check runs per request, so double-clicks can over-sell low stock. | `server.js:433` (returns 303, but a second POST before the redirect still runs to completion). |
| 🟠 | **`Set-Cookie` overwrites** (see §2.3) cause cart/session cookies to be dropped on responses that set both. Manifests as "cart empties after sign-up" intermittently. | `lib/auth.js:65`, `lib/cart.js:27`. |
| 🟡 | **Email shell hardcodes "support@vennixstore.com" and a Brooklyn address.** After running `npm run brand` these strings in `lib/commerce.js:emailShell` still read "44 Wythe Ave, Brooklyn NY 11249 · support@vennixstore.com", so a rebranded store's transactional footer still says Vennix. | `lib/commerce.js` line ~160. |
| 🟡 | **Search filter / sort / pagination parameters are not validated before being interpolated.** They appear to be coerced safely but the catalog page trusts `query.sort` to index into a list; if an attacker passes an unexpected value the sort falls back to default silently — not a bug but a missed 400. | `lib/pages/catalog.js`. |
| 🟡 | **`commerce.TAX_RATES[state] === undefined ? 0.06 : …`** defaults unknown states to **6% tax** rather than 0, mis-taxing exempt states and territories. If `shipProvince` is garbage (e.g. a client sent "XX"), tax is still charged. | `lib/commerce.js:98`. |
| 🔵 | **Server console prints passwords on boot.** The admin credentials string is printed every boot (`server.js:623`). Fine for demo, remove for production. | `server.js:623`. |
| 🔵 | **`PORT` default message prints `localhost:${PORT}` even when bound to `0.0.0.0`**. Minor cosmetic; also the banner always says "Card Payments (sandbox) (sandbox)" (the word "sandbox" is duplicated — `payments.provider` already ends with "(sandbox)"). | `server.js:621-623`, `lib/seed.js:596`. |

---

## 4. Code quality & architecture

**Positives**

- **Truly zero runtime dependencies** — Node built-ins only. The
  `package.json` has no `dependencies` block, `devDependencies` is used
  only for an opt-in `jsdom` for browser smoke tests. Supply-chain
  attack surface is minimal.
- **Good cryptographic hygiene where it matters**:
  `crypto.scryptSync` with per-user 16-byte salt and
  `crypto.timingSafeEqual` for password verify (`lib/auth.js`); random
  session IDs with `crypto.randomBytes(24)`; 30-day rolling sessions
  stored server-side.
- **Server-authoritative cart** (`lib/cart.js`): prices, discounts,
  shipping, tax and stock are all recomputed from the catalogue on
  every request; the client sends only variant id + quantity. This is
  the right shape for an e-commerce app and is why `npm run smoke`
  passes with no price-manipulation bugs found.
- **Money in cents** end to end, with a single `money()` formatter at
  the edge (`lib/commerce.js:40-42`). No float arithmetic in prices.
- **Personalization / monogramming logic** correctly prevents merging
  monogrammed and un-monogrammed lines (`lib/cart.js:48-51`, the
  `lineKey` comment is excellent).
- **Tests are real** — `scripts/smoke.js` boots the server over HTTP,
  hits 119 assertions across storefront, admin, POS, fulfilment,
  refunds, SEO, and checks the response bodies rather than just status
  codes. The theme check validates Liquid references offline.
- **HTML escaping** is centralized (`ui.esc`, `ui.attr`) and used
  consistently across the ~2200 lines of server-rendered HTML in
  `lib/pages/*` and `lib/admin/router.js` — I did not find any
  server-side XSS sink in the rendered HTML.

**Things to improve**

- **One ~9000-line file (`lib/admin/router.js`)** mixes routing, auth,
  order workflow, product CRUD, settings and POS. It would benefit from
  being split into `lib/admin/{orders,products,customers,...}.js`.
- **Callback-based static file serving** (`sendFile` in `server.js:67`)
  while everything else is async/await — mixing styles makes the error
  paths harder to reason about.
- **No logging library.** `console.log`/`console.error` go to stdout
  with no levels, timestamps, or request IDs; `logActivity` is only for
  the admin audit trail.
- **Atomic JSON store is coarse-grained.** Every `save()` writes the
  entire DB 120ms after the first mutation; concurrent requests (the
  server is single-threaded but awaits) can race: `insert` pushes to an
  array, then `save()` writes `db` — two inserts in the same tick will
  both make it in (sync), but an async span between read and write can
  drop updates. For a single-process demo this is fine; for production
  it needs a real DB or a lock.
- **No input schema validation.** Fields like
  `values.firstName/lastName/city` are not length-bounded consistently
  across checkout vs admin vs account. `String(body.message).slice(0, 4000)`
  is done ad-hoc.
- **No HTTP request size/rate guards beyond the 512KB body cap** in
  `parseBody` (server.js:82) — that's good for JSON but large form
  uploads (e.g. future product image uploads) would need more.
- **`auth.sign` is exported but never used.** Cookies carry raw session
  IDs looked up server-side; signing is dead code.
- **Client JS uses ES5-style `var` and string concatenation everywhere
  in `public/js/main.js`** (741 lines). It works, but there's no
  bundler, no minification, no source maps, and no cache-busting
  fingerprint on `/js/main.js`, `/css/main.css` — returning visitors
  will see stale assets after deploys.

---

## 5. Configuration & operability

- **No `.env.example` and no environment-variable config surface.** The
  only env vars read are `PORT` and `HOST`. Everything else (domain,
  brand, payment provider, free-shipping threshold, admin credentials)
  comes from `data/db.json` which is itself seeded. `npm run brand`
  overwrites the seed, which is awkward for 12-factor deploys.
- **No TLS, no trust proxy, no health endpoint.** Running behind a
  reverse proxy is assumed (the README says nothing about it) but the
  app does not honor `X-Forwarded-Proto` — absolute URLs in emails,
  sitemap, password-reset links all use `https://${settings.domain}`
  directly, which is correct, but there's no way to run HTTPS locally.
- **CI installs jsdom from npm at verify time**
  (`npm install --no-save jsdom`, `.github/workflows/verify.yml:22`).
  That makes the verify job non-reproducible (a future jsdom release
  could break it). Pinning to a version or committing a
  devDependency is safer.
- **No `engines` lockfile** — there's no `package-lock.json`, so
  installs are non-reproducible. (The README advertises "zero runtime
  dependencies" but `npm install` in CI still populates node_modules
  with transitive deps from jsdom.)
- **No Dockerfile, no systemd unit, no deploy script beyond the Shopify
  exporter.** `docs/SETUP.md` mentions CI but not production hosting.

---

## 6. Verification results (after extracting the zip)

```
npm run check        → all modules load cleanly           (pass)
npm run smoke        → 119 passed, 0 failed              (pass)
npm run features     → 41 passed, 0 failed               (pass)
npm run links        → 43 pages OK · 0 broken            (pass)
npm run theme:check  → 13 checks passed                  (pass)
npm run start        → boots, serves storefront + admin  (pass)
```

`npm run check:render`, `npm run browser:test` require jsdom and a
spare port; they were not run in this audit (browser-smoke needs jsdom
installed in `/tmp/jsdom` per the README).

---

## 7. Recommended priority order

**Do before any deployment (even a demo):**

1. Extract `vennix-storefront (1).zip` into the working tree and
   delete/ignore the zip so that `git clone && npm start` works.
2. Remove the hardcoded admin password; generate a one-time secret or
   read from `ADMIN_PASSWORD`. Delete the pre-filled password from the
   login HTML.
3. Add CSRF tokens (or at least an `Origin` check for same-origin and a
   custom header for JSON API calls).
4. Fix the `Set-Cookie` overwrite bug with `appendHeader`.
5. Fix the password-reset email URL **and** enforce `resetExpires`.
6. Add basic security headers: `X-Frame-Options`, `Content-Security-Policy`,
   `Strict-Transport-Security` (when deployed behind TLS), and
   `Permissions-Policy`.
7. Gate payment authorization on `settings.payments.testMode === true`
   and add an idempotency key to `/checkout`.

**Do soon:**

8. Add rate limiting to `/admin/login`, `/account/login`, `/track`,
   `/orders/:id`, `/api/newsletter`, `/api/contact`, `/api/notify`.
9. Make session/cart cookies `Secure` in production; make cart cookie
   `HttpOnly`.
10. Replace sequential public order numbers with random IDs or sign
    them.
11. Fix the hardcoded Vennix support address in
    `lib/commerce.js:emailShell` so `npm run brand` actually rebrands
    emails end-to-end.
12. Add CSRF tokens to admin POSTs.
13. Fix the DOM XSS in `public/js/main.js` search empty-state.
14. Add `.gitignore` entries for `data/db.*.corrupt-*.json`,
    `data/db.json.tmp`, `/dist`, `/coverage`.

**Nice-to-have:**

15. Split `lib/admin/router.js` into per-domain modules.
16. Add a `package-lock.json` and pin jsdom in devDependencies.
17. Add cache-busting fingerprints to static assets or at least
    `Cache-Control: immutable` with hashed filenames.
18. Add request logging (pino/morgan-style) and request IDs.
19. Fix the duplicated "(sandbox)" word in the boot banner.
20. Decide whether `seo/` belongs in the repo; if so document it, if not
    add it to `.gitignore`.

---

## 8. Files I extracted for this audit

Because the working tree was incomplete, I extracted
`vennix-storefront (1).zip` into `/tmp/vennix-extract/` and copied the
missing directories into the repo root to run the test suite:

```
.github/  data/  docs/  lib/  public/  scripts/  seo/  shopify-theme/
```

I did **not** commit those copies; they exist only in the snapshot so
you can inspect them. The cleanest path forward is to delete
`vennix-storefront (1).zip`, re-add the extracted directories in a
single commit, and update `.gitignore` so `data/db.json`,
`data/emails/`, `data/db.*.corrupt-*.json` and `dist/` stay out of Git.
