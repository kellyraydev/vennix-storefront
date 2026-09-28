'use strict';
/**
 * server.js — the Vennix storefront, presentation layer only.
 *
 * Architecture after the Shopify migration:
 *   - Products, variants, pricing, inventory, collections, pages, articles,
 *     carts, discounts, checkout and orders all live in Shopify and are read
 *     through lib/shopify (Storefront API via lib/shopify/catalog + cart-api).
 *   - This server renders the editorial storefront UI and hands checkout off
 *     to Shopify's hosted checkout (GET/POST /checkout → 302/303, allowlisted).
 *   - Local persistence is limited to non-commerce leads (newsletter, contact
 *     messages, back-in-stock alerts, review submissions) in lib/leads.
 *
 * Demo mode: when SHOPIFY_STORE_DOMAIN is not configured, an in-process mock
 * Shopify gateway (tools/mock-shopify) serves the committed fixture through
 * the exact same GraphQL code path, clearly labelled in the UI. Demo mode is
 * impossible in production (NODE_ENV=production) unless VENNIX_ALLOW_DEMO=1,
 * and impossible while a real store is configured — see lib/shopify/config.js.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Load .env / .env.local first so real credentials can live outside git.
require('./lib/env').loadEnv({ cwd: __dirname, quiet: process.env.NODE_ENV === 'test' });

const auth = require('./lib/auth');
const settings = require('./lib/settings');
const leads = require('./lib/leads');
const cartLib = require('./lib/cart');
const layout = require('./lib/layout');
const api = require('./lib/api');
const security = require('./lib/security');
const compress = require('./lib/compress');
const statusPage = require('./lib/pages/status');
const catalog = require('./lib/shopify/catalog');
const client = require('./lib/shopify/client');
const shopifyConfig = require('./lib/shopify/config');
const { preflight, formatPreflight } = require('./lib/shopify/preflight');
const locks = require('./lib/locks');
const { makeLimiter } = require('./lib/ratelimit');

const home = require('./lib/pages/home');
const collectionPage = require('./lib/pages/catalog');
const productPage = require('./lib/pages/product');
const cartPage = require('./lib/pages/cart');
const checkoutPage = require('./lib/pages/checkout');
const accountPage = require('./lib/pages/account');
const content = require('./lib/pages/content');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const limiter = makeLimiter();
const startedAt = Date.now();
let DEMO_MODE = false;
let gateway = null;

/* ------------------------------ small helpers ----------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.map': 'application/json'
};

/** Pick an encoding the client offered, for a body worth compressing. */
function pickEncoding(req, contentType, size) {
  if (!req || process.env.COMPRESSION_OFF === '1') return 'identity';
  if (size < compress.MIN_BYTES) return 'identity';
  if (!compress.isCompressible(contentType)) return 'identity';
  return compress.chooseEncoding(req.headers['accept-encoding']);
}

async function sendHtml(req, res, html, status = 200, extraHeaders = {}) {
  const raw = Buffer.from(html);
  const encoding = pickEncoding(req, 'text/html; charset=utf-8', raw.length);
  let body = raw;
  if (encoding !== 'identity') {
    try { body = await compress.compressBuffer(raw, encoding); } catch { body = raw; }
  }
  const headers = security.securityHeaders({
    req,
    extra: {
      'Content-Type': 'text/html; charset=utf-8',
      // Cart state is per-visitor and the CSP nonce is per-request: never a
      // shared-cache response.
      'Cache-Control': 'private, no-store',
      'Vary': 'Cookie, Accept-Encoding',
      'Content-Length': body.length,
      ...(encoding !== 'identity' ? { 'Content-Encoding': encoding } : {}),
      ...extraHeaders
    }
  });
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function sendJson(req, res, obj, status = 200) {
  const raw = Buffer.from(JSON.stringify(obj));
  const contentType = 'application/json; charset=utf-8';
  const encoding = pickEncoding(req, contentType, raw.length);
  let body = raw;
  if (encoding !== 'identity') {
    try { body = await compress.compressBuffer(raw, encoding); } catch { body = raw; }
  }
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Vary': 'Cookie, Accept-Encoding',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    ...(encoding !== 'identity' ? { 'Content-Encoding': encoding } : {})
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function redirect(res, location, status = 302) {
  res.writeHead(status, {
    Location: location,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  res.end();
}

function notModified(res, etag, cacheControl) {
  res.writeHead(304, {
    'Cache-Control': cacheControl,
    'ETag': etag,
    'Vary': 'Accept-Encoding'
  });
  res.end();
}

/**
 * Static assets: weak ETag (size + mtime), conditional 304s, brotli/gzip, and
 * honest cache lifetimes. CSS/JS revalidate quickly (so a deploy is visible in
 * minutes, not a day); images are immutable enough to cache for a week.
 */
async function sendFile(req, res, filePath, { longCache = false } = {}) {
  let stat;
  const missing = () => {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end('Not found');
  };
  try { stat = await fs.promises.stat(filePath); } catch { return missing(); }
  if (!stat.isFile()) return missing();

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const cacheControl = longCache ? 'public, max-age=604800, must-revalidate' : 'public, max-age=300, must-revalidate';

  if (req.headers['if-none-match'] === etag) return notModified(res, etag, cacheControl);

  const encoding = pickEncoding(req, contentType, stat.size);
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'ETag': etag,
    'Vary': 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff'
  };

  if (encoding === 'identity') {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const key = compress.cacheKey(filePath, stat, encoding);
  const cached = compress.cachedBody(key);
  let body = cached;
  if (!body) {
    try {
      body = await compress.compressBuffer(await fs.promises.readFile(filePath), encoding);
      compress.storeBody(key, body);
    } catch {
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  headers['Content-Length'] = body.length;
  headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function parseBody(req, limit = 128 * 1024) {
  return new Promise(resolve => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { resolve(null); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      const type = (req.headers['content-type'] || '');
      if (type.includes('application/json')) {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      } else if (type.includes('application/x-www-form-urlencoded')) {
        const out = {};
        for (const pair of data.split('&')) {
          const idx = pair.indexOf('=');
          if (idx === -1) continue;
          out[decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '))] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
        }
        resolve(out);
      } else resolve({});
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * CSRF defense for state-changing requests: Origin/Referer must match the
 * request's Host, and — when the visitor holds the vnx_csrf cookie (every
 * browser session does) — the X-CSRF-Token header must echo it. SameSite=Lax
 * cookies blunt form-submit CSRF in modern browsers; this is defense-in-depth.
 */
function sameOrigin(req) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (!host) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).hostname.toLowerCase() === host; } catch { return false; }
  }
  const ref = req.headers.referer;
  if (ref) {
    try { return new URL(ref).hostname.toLowerCase() === host; } catch { return false; }
  }
  return true; // curl / non-browser clients without these headers
}

function refuse(res, status, message, extra = {}) {
  // Short plain-text refusals still get nosniff: they are responses on the
  // storefront origin and nothing here should ever be reinterpreted as script.
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra
  });
  res.end(message);
}

/** Shared 429 shape: `Retry-After` on every rejection, so clients back off. */
function tooManyRequests(res, retryAfterSeconds) {
  res.writeHead(429, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Retry-After': String(retryAfterSeconds),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end('Too many requests — slow down a moment.');
}

/** Pages that must never be indexed (cart, checkout, internal search, account). */
function noindexFor(pathname) {
  return /^\/(search|cart|checkout|track|account)(\/|$)/.test(pathname);
}

/* -------------------------------- context --------------------------------- */

async function makeCtx(req, res, url, query) {
  const [chrome, cart] = await Promise.all([
    layout.prepareChrome(),
    cartLib.getDisplayCartFor(req, res)
  ]);
  return {
    req, res, url, query,
    settings: settings.get(),
    chrome,
    cart,
    flash: null,
    body: () => parseBody(req),
    demo: DEMO_MODE
  };
}

function navActiveFor(pathname) {
  if (pathname.startsWith('/collections') || pathname.startsWith('/products') || pathname === '/gift-cards') return 'shop';
  if (pathname.startsWith('/blogs')) return 'journal';
  if (pathname.startsWith('/pages/about')) return 'about';
  if (pathname.startsWith('/pages/faq')) return 'help';
  return '';
}

async function renderPage(ctx, page) {
  const inCart = new Set(ctx.cart.lines.map(l => l.handle));
  const upsellProducts = ctx.chrome.products.filter(p => !inCart.has(p.handle) && !p.hidden).slice(0, 3);
  const html = await layout.shell({
    title: page.title,
    description: page.description,
    canonical: page.canonical,
    jsonLd: page.jsonLd || [],
    bodyClass: page.bodyClass || '',
    content: page.content,
    settings: ctx.settings,
    cart: ctx.cart,
    chrome: ctx.chrome,
    navActive: navActiveFor(ctx.url.pathname),
    upsellProducts,
    demo: DEMO_MODE,
    robots: page.robots || (noindexFor(ctx.url.pathname) ? 'noindex,follow' : '')
  });
  await sendHtml(ctx.req, ctx.res, html, page.status || 200);
}

async function notFound(ctx) {
  const page = content.render404(ctx);
  const html = await layout.shell({
    title: page.title, description: page.description, canonical: page.canonical,
    jsonLd: [], bodyClass: page.bodyClass, content: page.content,
    settings: ctx.settings, cart: ctx.cart, chrome: ctx.chrome, navActive: '', upsellProducts: [],
    demo: DEMO_MODE, robots: 'noindex,follow'
  });
  await sendHtml(ctx.req, ctx.res, html, 404);
}

/**
 * Failure pages. A Shopify outage is not a 500: shoppers get a branded pause
 * screen with Retry-After, and nothing internal is echoed.
 */
async function serverError(ctx, err) {
  const isShopify = err && (err.name === 'ShopifyError' || /storefront api|shopify/i.test(err.message || ''));
  console.error('[server] render error', ctx.url && ctx.url.pathname, isShopify ? '(shopify)' : '', err && err.message);
  if (!isShopify) console.error(err);
  const page = isShopify ? statusPage.unavailable({ retryAfter: 30 }) : statusPage.error();
  try {
    const headers = page.retryAfter ? { 'Retry-After': String(page.retryAfter) } : {};
    await sendHtml(ctx.req, ctx.res, page.html, page.status, headers);
  } catch { /* response already gone */ }
}

/* ------------------------------ sitemap + robots --------------------------- */

async function sitemapXml() {
  const cfg = settings.get();
  const [collections, products, pages, articles] = await Promise.all([
    catalog.getCollections(), catalog.getAllProducts(), catalog.getPages(), catalog.getArticles()
  ]);
  const base = `https://${cfg.domain}`;
  const url = (loc, lastmod, priority = 0.5) =>
    `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}<priority>${priority}</priority></url>`;
  const rows = [
    url(base + '/', undefined, 1.0),
    ...collections.map(c => url(`${base}/collections/${c.handle}`, c.updatedAt, 0.8)),
    url(`${base}/collections/sale`, undefined, 0.6),
    ...products.filter(p => !p.hidden).map(p => url(`${base}/products/${p.handle}`, p.updatedAt, 0.9)),
    url(`${base}/gift-cards`, undefined, 0.7),
    ...pages.map(p => url(`${base}/pages/${p.handle}`, p.updatedAt, 0.4)),
    url(`${base}/blogs/journal`, undefined, 0.6),
    ...articles.map(a => url(`${base}/blogs/journal/${a.handle}`, a.publishedAt, 0.5))
  ].filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

function robotsTxt() {
  const cfg = settings.get();
  return `User-agent: *\nAllow: /\nDisallow: /checkout\nDisallow: /cart\nDisallow: /account\nDisallow: /api/\nSitemap: https://${cfg.domain}/sitemap.xml\n`;
}

/* --------------------------------- routing --------------------------------- */

async function handle(req, res, url, query) {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();
  const isFormPost = String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded');

  // static assets
  if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/images/') || pathname === '/favicon.svg' || pathname === '/apple-touch-icon.png') {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return refuse(res, 400, 'Bad request'); }
    const safe = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.resolve(PUBLIC_DIR, '.' + path.posix.sep + safe.replace(/^[/\\]+/, ''));
    // Containment by relative path, not by string prefix: `startsWith(PUBLIC_DIR)`
    // would also accept a sibling directory such as `public-evil`.
    const inside = path.relative(PUBLIC_DIR, filePath);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      return refuse(res, 400, 'Bad request');
    }
    return sendFile(req, res, filePath, { longCache: pathname.startsWith('/images/') });
  }
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(robotsTxt());
  }
  if (pathname === '/healthz') return sendJson(req, res, healthPayload());
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Allow': 'GET, HEAD, POST, OPTIONS',
      'Content-Length': 0,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end();
  }

  // Global per-IP request limit (blunt, protects the Node process itself).
  if (!limiter.allow(req, 'requests', { windowMs: 60_000, max: 900 })) {
    return tooManyRequests(res, 60);
  }

  // Every browser session gets a CSRF token to echo back on writes.
  security.ensureCsrfCookie(req, res, { secure: security.isSecure(req) });

  // CSRF defense for all state-changing requests
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (!sameOrigin(req)) {
      return refuse(res, 403, 'Cross-origin request blocked.');
    }
    // Form-encoded posts are verified in the handler (the token is a form field).
    if (!isFormPost) {
      const check = security.verifyCsrf(req);
      if (!check.ok) return refuse(res, 403, 'CSRF token missing or invalid.');
    }
    if (!limiter.allow(req, 'writes', { windowMs: 10_000, max: 120 })) {
      return tooManyRequests(res, 10);
    }
  }


  const ctx = await makeCtx(req, res, url, query);

  // JSON API
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return api.handle(ctx);
  }

  // legacy admin surface is retired — Shopify admin is the only one
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    return sendHtml(req, res, `<!doctype html><html lang="en"><head><title>Admin</title></head>
      <body style="font-family:system-ui;max-width:640px;margin:10vh auto;padding:0 20px">
      <h1>Products and orders live in Shopify</h1>
      <p>The custom Vennix admin was retired in the Shopify migration. Manage the
      catalog, orders, customers and discounts in the Shopify admin.</p>
      <p><a href="/">Back to the storefront</a></p></body></html>`, 404);
  }

  // checkout handoff — the one route that exists only to redirect
  if (pathname === '/checkout') {
    if (ctx.cart.count) {
      try {
        const checkoutUrl = await cartLib.checkoutUrlFor(req);
        if (checkoutUrl) {
          leads.logActivity('storefront', 'checkout.begin', `${ctx.cart.count} items`);
          return redirect(res, checkoutUrl, method === 'POST' ? 303 : 302);
        }
      } catch (err) { console.error('[checkout] handoff failed', err); }
      return renderPage(ctx, checkoutPage.render(ctx));
    }
    return renderPage(ctx, checkoutPage.render(ctx));
  }

  // lead capture: contact form (the only page POST)
  if (pathname === '/pages/contact' && method === 'POST') {
    const body = await parseBody(req);
    const values = body || {};
    const csrf = security.verifyCsrf(req, values[security.CSRF_FIELD]);
    if (!csrf.ok) return refuse(res, 403, 'Your session expired — reload the page and try again.');
    const required = ['name', 'email', 'message'];
    let error = '';
    for (const f of required) if (!String(values[f] || '').trim()) error = 'Please complete all required fields.';
    if (!error && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) error = 'Enter a valid email address.';
    if (!error) {
      leads.insert('messages', {
        name: String(values.name).slice(0, 120), email: String(values.email).slice(0, 160),
        topic: String(values.topic || 'Something else').slice(0, 60),
        orderNumber: String(values.orderNumber || '').slice(0, 40),
        message: String(values.message).slice(0, 4000), status: 'open', source: 'contact form'
      });
      leads.logActivity('storefront', 'message.created', `${values.email} — ${values.topic || 'message'}`);
      return redirect(res, '/pages/contact?sent=1', 303);
    }
    const page = await catalog.getPage('contact');
    if (page) {
      ctx.page = page;
      ctx.flash = { error, values };
      return renderPage(ctx, content.renderPage(ctx, 'contact'));
    }
    return redirect(res, '/pages/contact', 303);
  }

  const seg = pathname.split('/').filter(Boolean);

  try {
    if (pathname === '/') return renderPage(ctx, await home.render(ctx));

    if (seg[0] === 'collections' && seg.length === 1) return renderPage(ctx, await collectionPage.renderCollection(ctx, 'all'));
    if (seg[0] === 'collections' && seg.length === 2) {
      const page = await collectionPage.renderCollection(ctx, seg[1]);
      if (!page) return notFound(ctx);
      return renderPage(ctx, page);
    }

    if (seg[0] === 'products' && seg.length === 2) {
      const page = await productPage.render(ctx, seg[1]);
      if (!page) return notFound(ctx);
      return renderPage(ctx, page);
    }

    if (seg[0] === 'search') return renderPage(ctx, await collectionPage.renderSearch(ctx));

    if (seg[0] === 'cart') return renderPage(ctx, cartPage.render(ctx));

    if (seg[0] === 'track') return renderPage(ctx, checkoutPage.renderTrack(ctx));

    if (seg[0] === 'orders' && seg.length === 2) return renderPage(ctx, checkoutPage.renderLegacyOrder(ctx, seg[1]));

    if (seg[0] === 'account') {
      if (seg.length === 1) return renderPage(ctx, accountPage.overview(ctx));
      if (seg[1] === 'wishlist') return renderPage(ctx, accountPage.wishlist(ctx));
      // orders/addresses live in the Shopify-hosted account; legacy content
      // may still link the old routes, so send them somewhere real
      if (seg[1] === 'orders' || seg[1] === 'addresses' || seg[1] === 'details') {
        return redirect(res, ctx.settings.accountUrl || '/account');
      }
      if (['login', 'register', 'recover', 'reset', 'logout'].includes(seg[1])) {
        const accountUrl = ctx.settings.accountUrl;
        if (accountUrl) return redirect(res, accountUrl);
        return redirect(res, '/account');
      }
      return notFound(ctx);
    }

    if (seg[0] === 'blogs' && seg[1] === 'journal') {
      ctx.articles = await catalog.getArticles();
      if (seg.length === 2) return renderPage(ctx, content.renderJournal(ctx));
      ctx.article = await catalog.getArticle(seg[2]);
      if (!ctx.article) return notFound(ctx);
      return renderPage(ctx, content.renderPost(ctx, seg[2]));
    }

    if (seg[0] === 'gift-cards') return renderPage(ctx, content.renderGiftCards(ctx));

    if (seg[0] === 'pages' && seg.length === 2) {
      const page = await catalog.getPage(seg[1]);
      if (!page) return notFound(ctx);
      ctx.page = page;
      if (seg[1] === 'contact' && query.sent === '1') ctx.flash = { notice: 'Your message is with the studio. A human replies within one business day.' };
      return renderPage(ctx, content.renderPage(ctx, seg[1]));
    }

    if (seg[0] === 'sitemap.xml') {
      const xml = await sitemapXml();
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' });
      return res.end(xml);
    }

    return notFound(ctx);
  } catch (err) {
    return serverError(ctx, err);
  }
}

function healthPayload() {
  let cfg = null;
  try { cfg = shopifyConfig.getConfig(); } catch (err) { /* config errors are surfaced at boot */ }
  return {
    ok: true,
    demo: DEMO_MODE,
    mode: DEMO_MODE ? 'demo' : 'live',
    apiVersion: cfg ? cfg.version : shopifyConfig.DEFAULT_API_VERSION,
    // the domain is not a secret; the token never appears in any response
    store: cfg && cfg.domain ? cfg.domain : null,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    cache: catalog.cacheStats(),
    shopify: client.getMetrics(),
    locks: locks.stats(),
    // A capture that cannot be persisted is an outage, not a warning — alert on
    // `leads.writable === false` or any `leads.writeFailures`.
    leads: leads.stats(),
    proxy: { trustForwardedHeaders: auth.trustsProxy(), detected: auth.onProxyPlatform() || null }
  };
}

/* ---------------------------------- boot ----------------------------------- */

async function initialize() {
  const cfg = shopifyConfig.getConfig();

  if (cfg.demo) {
    DEMO_MODE = true;
    const { startMockGateway } = require('./tools/mock-shopify/gateway');
    gateway = await startMockGateway({ port: 0 });
    client.setEndpoint(gateway.url);
    console.log('[vennix] DEMO MODE — no SHOPIFY_STORE_DOMAIN configured.');
    console.log('[vennix] Mock Shopify gateway on an ephemeral port; using the committed fixture catalog.');
  } else {
    DEMO_MODE = false;
    console.log(`[vennix] Live mode — catalog and carts come from ${cfg.domain} (Storefront API ${cfg.version}).`);
    const result = await preflight();
    if (result.checks && result.checks.length) {
      console.log('[vennix] Connection preflight:');
      console.log(formatPreflight(result));
    }
    if (!result.ok) {
      throw new Error('Shopify connection preflight failed');
    }
  }

  if (process.env.VENNIX_SKIP_WARMUP !== '1') {
    try { await layout.prepareChrome(); } catch (err) {
      console.error('[vennix] catalog warm-up failed:', err.message);
    }
  }

  // Fail loudly about the two things that look fine until a human notices the
  // missing data: leads that cannot be written, and a proxy whose forwarded
  // headers we were told to ignore.
  const sink = leads.checkWritable();
  if (!sink.writable) {
    console.warn(`[vennix] lead capture is NOT durable: ${sink.file} is not writable (${sink.reason}).`);
    console.warn('[vennix] visitors will get a thank-you and the record will be dropped. Set LEADS_DIR to writable');
    console.warn('[vennix] persistent storage, or wire lib/leads.js to your own sink.');
  }
  const platform = auth.onProxyPlatform();
  if (platform && !auth.trustsProxy()) {
    console.warn(`[vennix] running on ${platform} with TRUST_PROXY explicitly off: every visitor shares one`);
    console.warn('[vennix] rate-limit bucket (900 req/min for the whole deployment). Unset TRUST_PROXY to auto-detect.');
  }
}

/**
 * Boot-once initialization, shared by every request.
 *
 * A failed init is remembered for `RETRY_COOLDOWN_MS` rather than retried per
 * request: while Shopify is refusing connections, a request-driven retry storm
 * (each attempt doing DNS + backoff retries) multiplies the outage and eats the
 * function's time budget. Inside the cooldown every request gets the same
 * failure immediately; the first one after it tries again.
 */
let initialization = null;
let initError = null;
let initRetryAt = 0;
const RETRY_COOLDOWN_MS = Number(process.env.VENNIX_INIT_RETRY_MS || 5000);

function ensureInitialized() {
  if (initialization) return initialization;
  if (initError && Date.now() < initRetryAt) return Promise.reject(initError);
  initialization = initialize()
    .then(() => { initError = null; })
    .catch(err => {
      initError = err instanceof Error ? err : new Error(String(err));
      initRetryAt = Date.now() + RETRY_COOLDOWN_MS;
      initialization = null;
      throw initError;
    });
  return initialization;
}

async function vercelHandler(req, res) {
  try {
    await ensureInitialized();
  } catch (err) {
    console.error('[vennix] initialization failed:', err && err.message ? err.message : err);
    return refuse(res, 503, 'Storefront temporarily unavailable.', { 'Retry-After': String(Math.ceil(RETRY_COOLDOWN_MS / 1000)) });
  }

  let url;
  try {
    // Only a trusted proxy's forwarded protocol is believed; a direct socket is
    // http unless TLS terminated it here. (Nothing renders an absolute URL from
    // this — canonicals come from PUBLIC_SITE_DOMAIN — but the request URL
    // should not be a place where an unvalidated header is trusted.)
    const forwarded = auth.trustsProxy()
      ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
      : '';
    const proto = forwarded === 'https' || (!forwarded && req.socket && req.socket.encrypted) ? 'https' : 'http';
    url = new URL(req.url || '/', `${proto}://${req.headers.host || 'localhost'}`);
  } catch {
    return refuse(res, 400, 'Bad request');
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const nonce = security.newNonce();
  return security.runWithRequest(
    { req, res, nonce, startedAt: Date.now() },
    () => handle(req, res, url, query).catch(err =>
      serverError({
        req, res, url,
        cart: { lines: [] },
        chrome: { products: [], collections: [] },
        settings: settings.get()
      }, err)
    )
  );
}

async function boot() {
  await ensureInitialized();

  const server = http.createServer((req, res) => {
    vercelHandler(req, res);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 30000;

  server.listen(PORT, HOST, () => {
    const bound = (server.address() && server.address().port) || PORT;
    console.log(`[vennix] Storefront listening on http://${HOST}:${bound}`);
    if (process.env.RENDER_EXTERNAL_URL) console.log(`[vennix] Preview: ${process.env.RENDER_EXTERNAL_URL}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`[vennix] ${sig} received, shutting down`);
      server.close(() => {
        if (gateway) gateway.close().finally(() => process.exit(0));
        else process.exit(0);
      });
      setTimeout(() => process.exit(1), 4000).unref();
    });
  }
}

if (require.main === module) {
  boot().catch(err => {
    console.error('[vennix] failed to boot:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { boot, handle, vercelHandler, DEMO_MODE: () => DEMO_MODE };
