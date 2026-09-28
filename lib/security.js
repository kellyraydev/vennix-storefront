'use strict';
/**
 * security.js — the request-scoped security primitives.
 *
 * Presentation layer only: this module never touches commerce data. It owns
 * the things that have to be true on *every* response:
 *
 *   - a per-request CSP nonce (AsyncLocalStorage, so any template can reach it)
 *   - the standard security header set (CSP, HSTS, nosniff, referrer, COOP…)
 *   - CSRF tokens (double-submit cookie) for state-changing requests
 *   - "is this request actually over TLS?" (proxy-aware)
 *   - checkout-URL allowlisting, so a handoff can never become an open redirect
 *   - helpers that assert no private Shopify credential ever reaches a response
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const auth = require('./auth');

const store = new AsyncLocalStorage();

/** Fallback used outside a request (scripts, warm-up, tests): random per boot. */
const BOOT_NONCE = crypto.randomBytes(18).toString('base64');

const CSRF_COOKIE = 'vnx_csrf';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_FIELD = '_csrf';
const CSRF_MAX_AGE = 12 * 60 * 60;

/* ------------------------------ request context ---------------------------- */

/**
 * Run `fn` inside a request context. Everything rendered while it runs can
 * call nonce()/nonceAttr() and get this request's nonce.
 */
function runWithRequest(ctx, fn) {
  return store.run(ctx, fn);
}

function current() {
  return store.getStore() || null;
}

/** The nonce for the request being rendered (or a per-boot one outside a request). */
function nonce() {
  const ctx = current();
  return (ctx && ctx.nonce) || BOOT_NONCE;
}

/** ` nonce="…"` ready to drop into a <script> or <style> tag. */
function nonceAttr() {
  return ` nonce="${nonce()}"`;
}

function newNonce() {
  return crypto.randomBytes(18).toString('base64');
}

/* --------------------------------- transport -------------------------------- */

/** Does this deployment sit behind a proxy we should read forwarded headers from? */
function trustsProxy() {
  return auth.trustsProxy();
}

/**
 * True when the visitor's connection is HTTPS (direct or via a TLS-terminating
 * proxy). Single source of truth: lib/auth.js (cookie flags depend on it too).
 */
function isSecure(req) {
  return auth.requestSecure(req);
}

function clientIp(req) {
  // Single source of truth (lib/auth.js): the socket address unless a proxy is
  // trusted, and never the forgeable leftmost X-Forwarded-For entry.
  return auth.clientIp(req);
}

/* ----------------------------------- CSP ----------------------------------- */

function trimOr(value, fallback) {
  const v = String(value == null ? '' : value).trim();
  return v || fallback;
}

/**
 * Build the Content-Security-Policy.
 *
 * Nonce-based for scripts (every inline <script> in the codebase carries
 * nonceAttr()). Inline *style* attributes stay allowed: the design system sets
 * CSS custom properties per element (swatch colours, stagger indices, progress
 * widths) and CSP has no nonce mechanism for attributes.
 *
 * Tighten further with CSP_IMG_SRC / CSP_CONNECT_SRC when you know your hosts.
 */
function csp({ nonceValue = nonce(), secure = false } = {}) {
  const imgSrc = trimOr(process.env.CSP_IMG_SRC, "'self' data: https:");
  const connectSrc = trimOr(process.env.CSP_CONNECT_SRC, "'self'");
  const scriptSrc = trimOr(process.env.CSP_SCRIPT_SRC, `'self' 'nonce-${nonceValue}'`);
  const styleSrc = trimOr(process.env.CSP_STYLE_SRC, "'self' 'unsafe-inline'");
  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc}`,
    `media-src 'self' https:`,
    `manifest-src 'self'`,
    `worker-src 'self'`,
    `frame-src 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    secure ? 'upgrade-insecure-requests' : ''
  ].filter(Boolean);
  const reportUri = String(process.env.CSP_REPORT_URI || '').trim();
  if (reportUri) directives.push(`report-uri ${reportUri}`);
  return directives.join('; ');
}

/** 'enforce' (default) | 'report-only' | 'off' */
function cspMode() {
  return String(process.env.CSP_MODE || 'enforce').toLowerCase();
}

/**
 * The full security header set for an HTML (or any) response.
 */
function securityHeaders({ req = null, nonceValue = null, extra = {} } = {}) {
  const secure = isSecure(req);
  const n = nonceValue || nonce();
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
    ...extra
  };
  // HTML pages are framed by no one (checkout is a top-level redirect, not an iframe).
  headers['X-Frame-Options'] = 'DENY';
  const mode = cspMode();
  const policy = csp({ nonceValue: n, secure });
  if (mode !== 'off') {
    headers[mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy'] = policy;
  }
  if (secure && process.env.HSTS_OFF !== '1') {
    headers['Strict-Transport-Security'] = process.env.HSTS_PRELOAD === '1'
      ? 'max-age=63072000; includeSubDomains; preload'
      : 'max-age=63072000; includeSubDomains';
  }
  return headers;
}

/* ----------------------------------- CSRF ----------------------------------- */

function newCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Read cookies, accepting either the bare or the `__Host-` prefixed names. */
function parseCookies(req) {
  return auth.parseCookies(req);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Mint (and set) a CSRF token cookie if the visitor does not have one yet. */
function ensureCsrfCookie(req, res, { secure = isSecure(req) } = {}) {
  const existing = auth.cookieValue(req, CSRF_COOKIE);
  if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing;
  const token = newCsrfToken();
  if (res && typeof res.setHeader === 'function') {
    // appendCookie, not setHeader: the cart cookie may already be queued.
    // Readable by public/js/main.js on purpose (double-submit), and it holds no
    // session data — it is an unguessable value, not an identity.
    auth.setCookie(res, CSRF_COOKIE, token, {
      httpOnly: false, sameSite: 'Lax', path: '/', maxAge: CSRF_MAX_AGE, secure
    });
  }
  return token;
}

function csrfTokenFrom(req) {
  return auth.cookieValue(req, CSRF_COOKIE) || '';
}

/**
 * Verify a state-changing request.
 *
 * Defense in depth layered on top of SameSite=Lax cookies and the Origin check
 * in server.js: a browser session always carries vnx_csrf, so a cross-site
 * POST (which cannot read that cookie) is refused. Non-browser clients with no
 * cookie are unaffected — they are already gated by the Origin check.
 *
 * @param {object} req
 * @param {string} [formToken] value of the `_csrf` field for form-encoded posts
 */
function verifyCsrf(req, formToken) {
  const cookie = csrfTokenFrom(req);
  if (!cookie) return { ok: true, reason: 'no-csrf-cookie' };
  const supplied = (req.headers && req.headers[CSRF_HEADER]) || formToken || '';
  if (!supplied) return { ok: false, reason: 'missing-token' };
  if (!safeEqual(supplied, cookie)) return { ok: false, reason: 'token-mismatch' };
  return { ok: true, reason: 'ok' };
}

/* ------------------------------ checkout handoff ---------------------------- */

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * A checkout URL may only point at Shopify. Defends the /checkout redirect and
 * the buy-now response against an open redirect if cart data were ever tampered
 * with, and makes any misconfiguration fail loudly instead of silently.
 */
function isAllowedCheckoutUrl(url, cfg = {}) {
  if (typeof url !== 'string' || !url) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const allowed = new Set([
    'checkout.shopify.com',
    'checkout.shopifycdn.com',
    'pay.shopify.com'
  ]);
  for (const value of [cfg.domain, cfg.primaryDomain]) {
    if (value) allowed.add(String(value).replace(/^https?:\/\//, '').split('/')[0].toLowerCase());
  }
  if (cfg.accountUrl) { const h = hostOf(cfg.accountUrl); if (h) allowed.add(h); }
  String(process.env.SHOPIFY_CHECKOUT_HOSTS || '').split(',')
    .map(s => s.trim().toLowerCase()).filter(Boolean).forEach(h => allowed.add(h));

  if (allowed.has(host)) return true;
  // any store's myshopify domain, and Shopify's regional checkout hosts
  if (/(^|\.)myshopify\.com$/.test(host)) return true;
  if (/(^|\.)shopify\.com$/.test(host)) return true;
  if (/(^|\.)shopifycdn\.com$/.test(host)) return true;
  return false;
}

/* ------------------------------ credential safety --------------------------- */

/** Secret-looking values that must never appear in a response or a committed file. */
function secretValues() {
  const out = [];
  for (const key of ['SHOPIFY_STOREFRONT_ACCESS_TOKEN', 'SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_APP_SECRET', 'SHOPIFY_API_SECRET']) {
    const v = process.env[key];
    if (v && String(v).trim().length >= 8) out.push({ key, value: String(v).trim() });
  }
  return out;
}

/** Throws if any configured secret leaked into `text`. Used by scripts/secret-scan.js. */
function assertNoSecrets(text) {
  const body = String(text || '');
  for (const { key, value } of secretValues()) {
    if (body.includes(value)) return { ok: false, key };
  }
  return { ok: true };
}

/** Redact a secret for logs: keep the shape, drop the value. */
function redact(value) {
  const v = String(value == null ? '' : value);
  if (!v) return '(not set)';
  if (v.length <= 10) return `${v.slice(0, 2)}…${'*'.repeat(6)}`;
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

module.exports = {
  runWithRequest, current, nonce, nonceAttr, newNonce,
  trustsProxy, isSecure, clientIp, parseCookies,
  csp, cspMode, securityHeaders,
  CSRF_COOKIE, CSRF_HEADER, CSRF_FIELD,
  newCsrfToken, ensureCsrfCookie, csrfTokenFrom, verifyCsrf, safeEqual,
  isAllowedCheckoutUrl, hostOf,
  secretValues, assertNoSecrets, redact
};
