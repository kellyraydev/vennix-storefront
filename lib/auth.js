'use strict';
/**
 * auth.js — cookie plumbing only.
 *
 * Authentication itself (customer accounts, logins, order history) belongs
 * to Shopify customer accounts — the storefront only keeps the cookie
 * utilities used by the cart-id and CSRF cookies. The full session/password
 * admin that used to live here is retired with the custom backend
 * (legacy/auth.js).
 *
 * Two things this module guarantees:
 *   1. `Set-Cookie` is always appended, never overwritten (Node's setHeader
 *      would otherwise drop a cookie set earlier in the same request).
 *   2. Cookies are `Secure` as soon as the visitor's connection is TLS —
 *      including behind a TLS-terminating proxy — and, when every response is
 *      guaranteed TLS, they are additionally locked to the exact host with
 *      the `__Host-` prefix so a subdomain can never set or shadow them.
 *   3. There is exactly one answer to "which visitor is this?" (`clientIp`),
 *      shared by the rate limiter and the cart-burst session key, and it is
 *      never the leftmost — i.e. forgeable — forwarded header.
 */

const HOST_PREFIX = '__Host-';

function isProd() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Platform environments whose edge proxy *always* fronts every request and
 * writes the forwarded headers itself — so reading them is not a footgun, it is
 * the only way to tell two visitors apart. On these, `TRUST_PROXY` is implied.
 *
 * Each entry is [env var, predicate on the *normalised* value]. An unset var is
 * empty — never the string "undefined" — and a client cannot forge its way past
 * the rate limiter here, because we never take the leftmost forwarded value (see
 * clientIp) and these platforms overwrite `x-real-ip`.
 */
const PROXY_PLATFORMS = [
  ['VERCEL', v => v === '1' || v === 'true'],                       // Vercel (api/index.js)
  ['RENDER', v => v === 'true'],                                     // Render external services
  ['FLY_APP_NAME', v => v.length > 0],                                // Fly.io (set to the app name)
  ['RAILWAY_ENVIRONMENT', v => v.length > 0 && v !== 'preview']      // Railway
];

function platformVar(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return '';
  const v = String(raw).trim().toLowerCase();
  // A shell that `export`s an empty or placeholder value must not read as a
  // platform, and neither must the literal words a script might leave behind.
  return (v === 'false' || v === '0' || v === 'undefined' || v === 'null' || v === 'no') ? '' : v;
}

function onProxyPlatform() {
  for (const [key, predicate] of PROXY_PLATFORMS) {
    if (predicate(platformVar(key))) return key;
  }
  return null;
}

/**
 * Does this deployment sit behind a proxy we should read forwarded headers from?
 *
 * `TRUST_PROXY=1|true|yes|on` turns it on, `0|false|no|off` forces it off (the
 * only way to opt out — a proxy-fronted deploy that does not trust the proxy
 * gives every visitor one shared rate-limit bucket). Unset or `auto` enables
 * trust on known platform proxies only, never on a bare `node server.js`.
 */
function trustsProxy() {
  const v = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '' || v === 'auto') return onProxyPlatform() !== null;
  return false; // an unrecognised value is not a reason to trust forged headers
}

/**
 * The address the request actually came from — the single source of truth for
 * rate limiting and for the cart-burst session key.
 *
 * Behind a proxy the socket address belongs to the proxy, so keying on it makes
 * every visitor share one bucket (and, for cart memory, one session). Forwarded
 * headers are then read in this order:
 *
 *   1. `x-real-ip` — the peer the edge proxy saw; a client cannot set it,
 *      because the platforms we auto-detect overwrite it.
 *   2. the **rightmost** `x-forwarded-for` entry — an appending proxy
 *      (`proxy_add_x_forwarded_for`) puts the real client last, so the leftmost
 *      entry is whatever the client chose to claim. Taking the first value is
 *      how a limiter is bypassed with a single forged header.
 *   3. the socket address, when there is no proxy to read.
 */
function clientIp(req) {
  const socketIp = (req && req.socket && req.socket.remoteAddress)
    ? String(req.socket.remoteAddress) : 'unknown';
  if (!req || !req.headers || !trustsProxy()) return socketIp;
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real;
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return socketIp;
}

/** True when the visitor's connection is HTTPS (direct or via a TLS-terminating proxy). */
function requestSecure(req) {
  if (isProd() && process.env.VENNIX_FORCE_INSECURE_COOKIES !== '1') return true;
  if (!req || !req.headers) return false;
  const proto = req.headers['x-forwarded-proto'];
  if (!proto) return false;
  // Only trust the header when we're told to, or when it is unambiguous https
  // (a direct http client cannot set it unless a proxy put it there).
  if (!trustsProxy() && process.env.VENNIX_TRUST_ANY_PROTO !== '1') return false;
  return String(proto).split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * Should cookies be locked to the host with the `__Host-` prefix?
 *
 * `__Host-` requires `Secure`, `Path=/` and no `Domain`, and browsers drop a
 * prefixed cookie that arrives over plain HTTP. So it is only ever enabled
 * when every response is guaranteed TLS, and it is decided once per process
 * (not per request) so a cookie is always set and cleared under the same
 * name.
 *
 *   COOKIE_HOST_PREFIX=auto  (default) on in production unless insecure
 *                            cookies are forced; off in dev/CI
 *   COOKIE_HOST_PREFIX=on    always (except when insecure cookies are forced)
 *   COOKIE_HOST_PREFIX=off   never
 */
function hostPrefixEnabled() {
  if (process.env.VENNIX_FORCE_INSECURE_COOKIES === '1') return false;
  const mode = String(process.env.COOKIE_HOST_PREFIX || 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return false;
  if (mode === 'on' || mode === '1' || mode === 'true') return true;
  return isProd();
}

/** The cookie name to actually write for a logical cookie name. */
function cookieName(base) {
  return hostPrefixEnabled() ? HOST_PREFIX + base : base;
}

function parseCookies(req) {
  const out = {};
  const header = (req && req.headers && req.headers.cookie) || '';
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let value;
    try { value = decodeURIComponent(part.slice(idx + 1).trim()); } catch { value = part.slice(idx + 1).trim(); }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Read a logical cookie by base name, accepting either the bare or the
 * `__Host-` prefixed form — a visitor whose first response predated a prefix
 * change (or who hit a non-TLS route once) keeps their cart.
 */
function cookieValue(req, base) {
  const cookies = parseCookies(req);
  const prefixed = HOST_PREFIX + base;
  // A __Host- cookie can only ever have been written by this exact host, so it
  // is always honoured — including when the prefix is currently off (a deploy
  // may turn it on and back off again).
  if (cookies[prefixed]) return cookies[prefixed];
  // The bare name is only honoured while the prefix is off: with the prefix on,
  // a sibling subdomain could otherwise plant a cookie for this host.
  if (!hostPrefixEnabled() && cookies[base]) return cookies[base];
  return null;
}

/**
 * Serialize one Set-Cookie value.
 *
 * When the name carries the `__Host-` prefix the attributes browsers require
 * are forced, because a prefixed cookie that violates them is rejected
 * outright (and the cart would silently stop persisting).
 */
function serializeCookie(name, value, {
  maxAge, httpOnly = true, sameSite = 'Lax', path = '/', secure = isProd(), domain = null
} = {}) {
  const prefixed = String(name).startsWith(HOST_PREFIX);
  const useSecure = prefixed ? true : secure;
  const usePath = prefixed ? '/' : path;
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${usePath}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (useSecure) bits.push('Secure');
  if (!prefixed && domain) bits.push(`Domain=${domain}`);
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
}

/**
 * Append a Set-Cookie header without clobbering previously set cookies.
 * Node's `res.setHeader('Set-Cookie', …)` replaces the header, so we build
 * an array of cookies and set them together.
 */
function appendCookie(res, cookie) {
  if (!res || typeof res.setHeader !== 'function') return;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) return res.setHeader('Set-Cookie', cookie);
  const arr = Array.isArray(existing) ? existing.slice() : [String(existing)];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

/** Set (or refresh) a logical cookie. */
function setCookie(res, base, value, opts = {}) {
  const { secure = isProd(), ...rest } = opts;
  appendCookie(res, serializeCookie(cookieName(base), value, { secure, ...rest }));
  return cookieName(base);
}

/** Expire a logical cookie — same name and flags, `Max-Age=0`. */
function clearCookie(res, base, opts = {}) {
  const { secure = isProd(), ...rest } = opts;
  appendCookie(res, serializeCookie(cookieName(base), '', { secure, maxAge: 0, ...rest }));
  return cookieName(base);
}

module.exports = {
  isProd,
  trustsProxy,
  onProxyPlatform,
  clientIp,
  requestSecure,
  hostPrefixEnabled,
  cookieName,
  parseCookies,
  cookieValue,
  serializeCookie,
  appendCookie,
  setCookie,
  clearCookie
};
