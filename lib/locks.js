'use strict';
/**
 * locks.js — two small pieces of single-process coordination that keep
 * concurrent shoppers from corrupting each other's cart.
 *
 * 1. `withLock(key, fn)` serialises work per cart. The storefront's add flow is
 *    read-modify-write (read cart → merge lines → update/add). Two taps on
 *    "add" at the same instant would otherwise both read quantity 1 and both
 *    write quantity 2, silently losing a unit (and, with the last unit in
 *    stock, letting a shopper past a stock check that Shopify then refuses at
 *    checkout).
 *
 * 2. `sessionCarts` remembers the cart id created for a visitor for a couple of
 *    minutes. The cart cookie is written on the *response*, so two parallel
 *    first-time adds cannot see each other and would each create a cart — one
 *    of which is then orphaned with the shopper's item in it.
 *
 * Single process only, same as the rate limiter: this storefront is designed to
 * run as one instance per deploy. Behind a multi-instance load balancer, use
 * sticky sessions (and Shopify stays authoritative regardless — the worst case
 * is an extra cart, never a wrong order).
 */
const crypto = require('crypto');
const auth = require('./auth');

const chains = new Map();
const MAX_CHAINS = 5000;

/** Run `fn` after (and never overlapping with) other work queued for `key`. */
function withLock(key, fn) {
  const k = String(key || 'default');
  if (chains.size > MAX_CHAINS) chains.clear();
  const prev = chains.get(k) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const stored = run.then(() => {}, () => {});
  chains.set(k, stored);
  stored.then(() => { if (chains.get(k) === stored) chains.delete(k); });
  return run;
}

/* --------------------------- session → cart memory -------------------------- */

/**
 * How long a freshly created cart id is remembered for a visitor who has no
 * cookie yet.
 *
 * Long enough to cover one click-burst (parallel add-to-cart requests from the
 * same tab), far too short to leak a cart between two different visitors who
 * happen to share an IP and user agent. Never minutes — that is how strangers
 * end up in each other's carts on a NAT.
 */
const TTL_WITH_CLIENT_ID = 2000;
const TTL_WITHOUT_CLIENT_ID = 750;
const MAX_SESSIONS = 5000;
const sessionCarts = new Map();
let writesSinceSweep = 0;

/** Per-tab id minted by public/js/main.js (vnx_sid). Empty for non-browser clients. */
function clientSessionId(req) {
  if (!req || !req.headers) return '';
  const header = req.headers['x-vennix-session'];
  if (header) return String(header).slice(0, 64);
  const cookie = String(req.headers.cookie || '');
  const m = /(?:^|; )vnx_sid=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]).slice(0, 64) : '';
}

/**
 * A coarse, non-identifying fingerprint of a visitor: client ip + user agent +
 * (when the browser provides it) the per-tab id.
 *
 * The IP must be the *visitor's* address, not the front proxy's: on a
 * proxy-fronted deployment the socket address is identical for every visitor,
 * so keying on it would let one visitor's just-created cart be picked up by an
 * unrelated one who happens to share a user agent. lib/auth.js `clientIp()` is
 * the single source of truth for that, and it refuses to guess.
 */
function sessionKey(req) {
  const ip = auth.clientIp(req);
  const ua = (req && req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
  const sid = clientSessionId(req);
  // Nothing to distinguish this visitor from the next one with the same user
  // agent — better to create a second cart (worst case: an orphan) than to
  // hand a stranger the wrong one.
  if (!sid && (ip === 'unknown' || !ip)) return null;
  if (!ip && !ua && !sid) return null;
  return crypto.createHash('sha256').update(`${ip}|${ua}|${sid}`).digest('hex').slice(0, 24);
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of sessionCarts) if (now - v.at > v.ttl) sessionCarts.delete(k);
}

function rememberCart(key, cartId, req = null) {
  if (!key || !cartId) return;
  if (sessionCarts.size > MAX_SESSIONS) sweep();
  const ttl = clientSessionId(req) ? TTL_WITH_CLIENT_ID : TTL_WITHOUT_CLIENT_ID;
  sessionCarts.set(key, { id: cartId, at: Date.now(), ttl });
  if (++writesSinceSweep > 200) { writesSinceSweep = 0; sweep(); }
}

function cartFor(key) {
  if (!key) return null;
  const hit = sessionCarts.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) { sessionCarts.delete(key); return null; }
  return hit.id;
}

function forgetCart(key) {
  if (key) sessionCarts.delete(key);
}

function stats() {
  return { locks: chains.size, sessions: sessionCarts.size };
}

module.exports = { withLock, sessionKey, clientSessionId, rememberCart, cartFor, forgetCart, stats,
  TTL_WITH_CLIENT_ID, TTL_WITHOUT_CLIENT_ID };
