'use strict';
/**
 * ratelimit.js — tiny in-memory sliding-window limiter keyed on IP + route.
 * Single-process only; enough to blunt credential stuffing and form spam.
 *
 * The client address comes from lib/auth.js `clientIp()` — the same answer the
 * cart session key uses — so the socket address is used directly and forwarded
 * headers only when a proxy is actually trusted (see lib/auth.js).
 */
const auth = require('./auth');

/**
 * The key a bucket is counted against. Delegated so that "who is this visitor"
 * has exactly one definition in the codebase.
 */
function getClientIp(req) {
  return auth.clientIp(req);
}

function makeLimiter({ maxBuckets = 5000, pruneTo = 4000 } = {}) {
  const buckets = new Map();

  function prune(windowMs) {
    if (buckets.size <= maxBuckets) return;
    const now = Date.now();
    for (const [k, v] of buckets) {
      const filtered = v.filter(t => now - t < windowMs);
      if (filtered.length === 0) buckets.delete(k);
      else if (filtered.length !== v.length) buckets.set(k, filtered);
      if (buckets.size <= pruneTo) break;
    }
  }

  /** Returns true when the request is allowed. */
  function allow(req, key, { windowMs = 60_000, max = 10 } = {}) {
    const ip = getClientIp(req);
    const bucketKey = `${ip}:${key}`;
    const now = Date.now();
    let bucket = buckets.get(bucketKey);
    bucket = (bucket || []).filter(t => now - t < windowMs);
    if (bucket.length >= max) {
      if (bucket.length === 0) buckets.delete(bucketKey);
      else buckets.set(bucketKey, bucket);
      prune(windowMs);
      return false;
    }
    bucket.push(now);
    buckets.set(bucketKey, bucket);
    prune(windowMs);
    return true;
  }

  /** Bucket count, for /healthz and the test suites. */
  function stats() { return buckets.size; }

  return { allow, stats, getClientIp };
}

module.exports = { makeLimiter, getClientIp };
