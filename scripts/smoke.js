'use strict';
/**
 * smoke.js — end-to-end route + flow test against a running storefront.
 *
 * Exercises the real production code path: storefront pages, the Shopify cart
 * API (create / add / update / remove / discount / note), the checkout handoff,
 * lead capture endpoints and SEO payloads. Works against demo mode (mock
 * Shopify gateway + fixture) or a live store alike.
 *
 * Usage: node scripts/smoke.js [baseUrl]
 */
const fs = require('fs');
const { ensureBase, startTestServer } = require('./helpers');

let pass = 0, fail = 0;
const failures = [];
let BASE = null;
let stopServer = null;

// A distinct user agent per run: the server keys short-lived cart memory on
// ip + user agent, and test suites must not inherit each other's carts.
const RUN_ID = `vennix-smoke/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Raw HTTP GET: fetch() transparently decompresses, so compression needs a socket. */
function rawGet(path, { acceptEncoding = 'identity' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const request = require('http').request({
      hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search,
      headers: { 'Accept-Encoding': acceptEncoding, 'User-Agent': RUN_ID }
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', c => { chunks.push(c); bytes += c.length; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function req(path, { method = 'GET', body, cookie, form, redirect = 'manual' } = {}) {
  const headers = { 'User-Agent': RUN_ID };
  if (cookie) {
    headers.Cookie = cookie;
    // mirror the browser: when a vnx_csrf cookie exists, the POST echoes it
    const csrf = /(?:^|; )vnx_csrf=([^;]+)/.exec(cookie);
    if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf[1]);
  }
  if (method !== 'GET') headers.Origin = BASE;
  let payload;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, location: res.headers.get('location'), text, json, setCookie };
}

function expect(label, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

(async function run() {
  const host = await ensureBase(process.argv[2]);
  BASE = host.base;
  stopServer = host.stop;
  console.log(`\nVennix smoke test → ${BASE}\n${'─'.repeat(48)}`);

  /* ------------------------------------------------------ storefront pages */
  console.log('\nStorefront pages');
  const pages = [
    ['/', 'Modern essentials'], ['/collections/all', 'All Products'], ['/collections/women', "Women"],
    ['/collections/men', "Men"], ['/collections/active', 'Active'], ['/collections/essentials', 'Essentials'],
    ['/collections/new-in', 'New In'], ['/collections/bestsellers', 'Bestsellers'], ['/collections/sale', 'Sale'],
    ['/products/atlas-heavyweight-hoodie', 'Atlas Heavyweight Hoodie'], ['/products/gift-card', 'Gift Card'],
    ['/search?q=hoodie', 'hoodie'], ['/cart', 'cart'], ['/checkout', 'checkout'],
    ['/track', 'Track your order'], ['/gift-cards', 'Gift cards'], ['/blogs/journal', 'Journal'],
    ['/blogs/journal/why-we-chose-480-gsm', '480'], ['/pages/about', 'About'], ['/pages/faq', 'FAQ'],
    ['/pages/size-guide', 'Size Guide'], ['/pages/contact', 'Contact'], ['/pages/shipping-returns', 'Shipping'],
    ['/pages/privacy', 'Privacy'], ['/pages/terms', 'Terms'], ['/pages/accessibility', 'Accessibility'],
    ['/account', 'account'], ['/account/wishlist', 'Saved items'],
    ['/robots.txt', 'Sitemap:'], ['/sitemap.xml', '<urlset'], ['/css/main.css', '--ink'], ['/js/main.js', 'addToCart'],
    ['/favicon.svg', '<svg']
  ];
  for (const [path, needle] of pages) {
    const res = await req(path);
    expect(`${path} ${res.status}`, res.status === 200 && res.text.includes(needle), `expected 200 + "${needle}", got ${res.status}`);
  }
  expect('404 for unknown product', (await req('/products/does-not-exist')).status === 404);
  expect('404 for unknown page', (await req('/pages/does-not-exist')).status === 404);
  expect('404 for unknown collection', (await req('/collections/does-not-exist')).status === 404);
  expect('hidden service product is not published', (await req('/products/monogramming')).status === 404);
  const admin = await req('/admin');
  expect('custom admin is retired (404 with pointer)', admin.status === 404 && admin.text.includes('Shopify'));

  /* ----------------------------------------------------------- cart + api */
  console.log('\nCart API (Shopify-backed)');
  const home = await req('/');
  let cookie = '';

  const search = await req('/api/search?q=legging', { cookie });
  expect('GET /api/search returns products', search.json && search.json.ok && search.json.products.length > 0);

  const quick = await req('/api/quickview/flow-high-rise-legging-28', { cookie });
  expect('GET /api/quickview returns variant picker html', quick.json && quick.json.ok && quick.json.html.includes('data-add-form'));

  const pdp = await req('/products/atlas-heavyweight-hoodie', { cookie });
  const match = pdp.text.match(/data-product-json="atlas-heavyweight-hoodie"[^>]*>([\s\S]*?)<\/script>/);
  const data = JSON.parse(match[1]);
  const variant = data.variants.find(v => v.stock > 5);
  expect('in-stock variant discovered from PDP', !!variant);

  const bogus = await req('/api/cart/add', { method: 'POST', cookie, body: { variantId: 'gid://shopify/ProductVariant/var_not_real', quantity: 1 } });
  expect('unknown variant is rejected', bogus.json && !bogus.json.ok && !!bogus.json.error);
  const soldOut = data.variants.find(v => v.stock <= 0);
  const out = await req('/api/cart/add', { method: 'POST', cookie, body: { variantId: soldOut.id, quantity: 1 } });
  expect('sold-out variant is rejected', out.json && !out.json.ok && /sold out/i.test(out.json.error));

  const add = await req('/api/cart/add', { method: 'POST', cookie, body: { variantId: variant.id, quantity: 1 } });
  expect('POST /api/cart/add adds a line', add.json && add.json.ok && add.json.cart.count === 1, JSON.stringify(add.json || {}).slice(0, 160));
  const cartSetCookie = add.setCookie.find(c => c.startsWith('vnx_cart=')) || '';
  cookie = (cartSetCookie || '').split(';')[0];
  expect('cart id stored in HttpOnly cookie on first add', !!cookie && /httponly/i.test(cartSetCookie), add.setCookie.join(' '));
  expect('cart html fragments returned', !!(add.json.html && add.json.html.drawer && add.json.html.count));
  expect('monogrammed flag false for plain add', add.json.monogrammed === false);

  const mono = await req('/api/cart/add', { method: 'POST', cookie, body: { variantId: variant.id, quantity: 1, personalization: { text: 'AB' } } });
  // identical garment lines merge; the monogram service line is folded into
  // the garment line for display — one merged line at quantity 2
  expect('monogram merges identical garment + service lines for display', mono.json.ok && mono.json.monogrammed === true && mono.json.cart.lines.length === 1 && mono.json.cart.lines[0].quantity === 2, JSON.stringify(mono.json.cart.lines));
  const monoLine = mono.json.cart.lines.find(l => l.personalization);
  expect('monogram line carries the fee', monoLine && monoLine.personalization.price === 2000);

  const lineId = mono.json.cart.lines.find(l => l.personalization).id;
  const upd = await req('/api/cart/update', { method: 'POST', cookie, body: { lineId, quantity: 3 } });
  expect('POST /api/cart/update syncs quantity to the service line too', upd.json.ok && upd.json.cart.count === 6, `count ${upd.json.cart && upd.json.cart.count}`);

  const disc = await req('/api/cart/discount', { method: 'POST', cookie, body: { code: 'WELCOME10' } });
  expect('POST /api/cart/discount applies WELCOME10', disc.json.ok && disc.json.cart.discountCode === 'WELCOME10');
  expect('discount amount is 10% of subtotal', disc.json.cart.discountAmount === Math.round(disc.json.cart.subtotal * 0.1), `${disc.json.cart.discountAmount} vs ${disc.json.cart.subtotal}`);
  const badDisc = await req('/api/cart/discount', { method: 'POST', cookie, body: { code: 'NOPE' } });
  expect('invalid discount is rejected with a reason', !badDisc.json.ok && !!badDisc.json.error);

  const noteRes = await req('/api/cart/note', { method: 'POST', cookie, body: { giftNote: 'Happy birthday from smoke test' } });
  expect('POST /api/cart/note accepts notes', noteRes.json.ok);
  const cartPage = await req('/cart', { cookie });
  expect('gift note renders on the cart page', cartPage.text.includes('Happy birthday from smoke test'));

  /* ------------------------------------------------------------ checkout */
  console.log('\nCheckout handoff (Shopify-hosted)');
  const handoff = await req('/checkout', { cookie, redirect: 'manual' });
  expect('GET /checkout with items redirects to Shopify checkout', handoff.status === 302 && /^https:\/\//.test(handoff.location || ''), `${handoff.status} ${handoff.location}`);
  const buyNow = await req('/api/buy-now', { method: 'POST', cookie, body: { variantId: variant.id, quantity: 1 } });
  expect('POST /api/buy-now returns a checkout URL', buyNow.json.ok && /^https:\/\//.test(buyNow.json.checkoutUrl));

  const rm = await req('/api/cart/remove', { method: 'POST', cookie, body: { lineId } });
  expect('removing the garment removes its monogram service line', rm.json.ok && !rm.json.cart.lines.some(l => l.personalization), `lines ${rm.json.cart.lines.length}`);

  const shipping = await req('/api/cart/shipping', { method: 'POST', cookie, body: {} });
  expect('legacy /api/cart/shipping still answers (no-op)', shipping.json.ok);

  /* --------------------------------------------------------------- leads */
  console.log('\nLead capture');
  const news = await req('/api/newsletter', { method: 'POST', cookie, body: { email: 'smoke.tester@example.com' } });
  expect('POST /api/newsletter subscribes', news.json.ok);
  const badNews = await req('/api/newsletter', { method: 'POST', cookie, body: { email: 'not-an-email' } });
  expect('newsletter rejects a bad email', !badNews.json.ok);
  const support = await req('/api/contact', { method: 'POST', cookie, body: { name: 'Smoke', email: 'smoke@example.com', topic: 'Sizing & fit', message: 'Automated smoke test message.' } });
  expect('POST /api/contact creates a message', support.json.ok);
  const review = await req('/api/reviews', { method: 'POST', cookie, body: { handle: 'atlas-heavyweight-hoodie', author: 'Smoke Bot', email: 'smoke@example.com', rating: 5, title: 'Automated check', body: 'Verifying the review pipeline end to end.' } });
  expect('review submits into moderation', review.json.ok && /moderation/i.test(review.json.message));
  const helpful = await req('/api/reviews/helpful/atlas-heavyweight-hoodie:0', { method: 'POST', cookie, body: {} });
  expect('helpful vote counts', helpful.json.ok && typeof helpful.json.helpful === 'number');
  const fit = await req('/api/fit', { method: 'POST', cookie, body: { handle: 'atlas-heavyweight-hoodie', height: 70, weight: 170 } });
  expect('POST /api/fit returns a recommendation', fit.json.ok && !!fit.json.fit.size);
  const monogram = await req('/api/monogram', { method: 'POST', cookie, body: { handle: 'atlas-heavyweight-hoodie', text: 'ab' } });
  expect('POST /api/monogram previews + prices', monogram.json.ok && monogram.json.text === 'AB' && monogram.json.price === 2000);
  const style = await req('/api/style?handle=atlas-heavyweight-hoodie&limit=3', { cookie });
  expect('GET /api/style returns partners', style.json.ok && style.json.look.length === 3);

  /* ------------------------------------------------------- security + seo */
  console.log('\nSecurity + SEO');
  const csrf = await fetch(BASE + '/api/newsletter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'csrf@example.com' })
  });
  expect('cross-origin POST is blocked (CSRF)', csrf.status === 403);
  const resp = await fetch(BASE + '/');
  expect('security headers set', resp.headers.get('x-content-type-options') === 'nosniff' && resp.headers.get('x-frame-options') === 'DENY');
  expect('catalog index embedded for wishlist', home.text.includes('data-catalog-index'));
  expect('structured data present', home.text.includes('"@type":"Organization"'));
  expect('PDP has Product schema', pdp.text.includes('"@type":"Product"'));
  const faq = await req('/pages/faq');
  expect('FAQ page has FAQPage schema', faq.text.includes('FAQPage'));
  const sitemap = await req('/sitemap.xml');
  expect('sitemap lists products and pages', sitemap.text.includes('/products/') && sitemap.text.includes('/pages/') && sitemap.text.includes('/collections/'));

  /* ------------------------------------------------- security hardening */
  console.log('\nContent-Security-Policy');
  const cspHeader = resp.headers.get('content-security-policy') || resp.headers.get('content-security-policy-report-only') || '';
  expect('a CSP is emitted', !!cspHeader, cspHeader.slice(0, 60));
  const nonceMatch = /'nonce-([^']+)'/.exec(cspHeader);
  expect('the CSP carries a per-request nonce', !!nonceMatch);
  const nonce = nonceMatch ? nonceMatch[1] : '';
  expect('the nonce is unique per response',
    nonce !== ((/nonce-([^']+)'/.exec((await fetch(BASE + '/')).headers.get('content-security-policy') || '') || [])[1] || nonce));
  const freshHome = await fetch(BASE + '/', { headers: { 'User-Agent': RUN_ID } });
  const freshHtml = await freshHome.text();
  const freshNonce = (/nonce-([^']+)'/.exec(freshHome.headers.get('content-security-policy') || '') || [])[1] || '';
  const inlineScripts = [...freshHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].map(m => m[0]);
  expect(`every inline <script> is nonced (${inlineScripts.length} on the home page)`,
    inlineScripts.length > 0 && inlineScripts.every(t => t.includes('nonce="')),
    inlineScripts.filter(t => !t.includes('nonce="')).join(' ').slice(0, 120));
  expect('the nonce in the page matches the nonce in that response\'s header',
    !!freshNonce && inlineScripts.every(t => t.includes(`nonce="${freshNonce}"`)));
  expect('the policy forbids framing, plugins and off-origin forms',
    /frame-ancestors 'none'/.test(cspHeader) && /object-src 'none'/.test(cspHeader) && /form-action 'self'/.test(cspHeader));

  console.log('\nCSRF (double-submit token)');
  const csrfCookie = (await fetch(BASE + '/')).headers.getSetCookie().find(c => c.startsWith('vnx_csrf=')) || '';
  const token = (csrfCookie.split(';')[0] || '').split('=')[1] || '';
  expect('a CSRF cookie is minted for the session', /^[a-f0-9]{64}$/.test(token), csrfCookie.slice(0, 40));
  const noToken = await fetch(BASE + '/api/cart', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: `vnx_csrf=${token}` }
  });
  expect('a POST without the token header is refused', noToken.status === 403, String(noToken.status));
  const withToken = await fetch(BASE + '/api/cart', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: `vnx_csrf=${token}`, 'X-CSRF-Token': token }
  });
  expect('the same POST with the token is accepted', withToken.status !== 403, String(withToken.status));
  const contactPage = await req('/pages/contact');
  expect('the contact form carries a CSRF field', contactPage.text.includes('name="_csrf"'));

  console.log('\nRate limiting');
  const flood = [];
  for (let i = 0; i < 9; i++) {
    flood.push(await fetch(BASE + '/api/newsletter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, 'User-Agent': RUN_ID },
      body: JSON.stringify({ email: `flood-${i}@example.com` })
    }));
  }
  const limited = flood.find(r => r.status === 429);
  expect('a flood of submissions is throttled', !!limited, `statuses ${flood.map(r => r.status).join(',')}`);
  expect('the 429 says when to retry', !!limited && !!limited.headers.get('retry-after'), limited && String(limited.headers.get('retry-after')));
  expect('a refusal says nosniff too', limited.headers.get('x-content-type-options') === 'nosniff');
  expect('a cross-origin refusal says nosniff too', csrf.headers.get('x-content-type-options') === 'nosniff');

  console.log('\nPer-visitor throttling behind a proxy');
  // The whole point of trusting a proxy is that the limiter still counts per
  // *visitor*. Keyed on the socket instead, every visitor shares one bucket and
  // a busy deploy starts 429-ing innocent traffic (and one attacker mints
  // unlimited buckets by forging the first X-Forwarded-For entry).
  const os = require('os');
  const proxyLeadsDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'vennix-proxy-leads-'));
  const proxyServer = await startTestServer({ env: { TRUST_PROXY: '1', LEADS_DIR: proxyLeadsDir } });
  try {
    const asVisitor = (xff, email) => fetch(`${proxyServer.base}/api/newsletter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: proxyServer.base, 'X-Forwarded-For': xff },
      body: JSON.stringify({ email })
    }).then(r => r.status);
    const six = [];
    for (let i = 0; i < 6; i++) six.push(await asVisitor(`203.0.113.${i + 1}`, `proxy-visitor-${i}@example.com`));
    expect('six distinct visitors each keep their own allowance', six.every(s => s === 200), six.join(','));
    const seventh = await asVisitor('198.51.100.7', 'proxy-visitor-7@example.com');
    expect('a seventh visitor is not throttled by the other six', seventh === 200, String(seventh));
    const sameVisitor = [];
    for (let i = 0; i < 8; i++) sameVisitor.push(await asVisitor('203.0.113.201', `proxy-same-${i}@example.com`));
    expect('one visitor over the per-IP limit is refused even behind the proxy',
      sameVisitor.filter(s => s === 429).length === 2, sameVisitor.join(','));
    const spoofed = [];
    for (let i = 0; i < 8; i++) spoofed.push(await asVisitor(`10.9.${i}.1, 203.0.113.202`, `proxy-spoof-${i}@example.com`));
    expect('a forged first hop does not buy a fresh bucket',
      spoofed.filter(s => s === 429).length === 2, spoofed.join(','));
    const health = await (await fetch(`${proxyServer.base}/healthz`)).json();
    expect('the health endpoint says the proxy is being read',
      health.proxy && health.proxy.trustForwardedHeaders === true, JSON.stringify(health.proxy));
  } finally {
    await proxyServer.stop();
    fs.rmSync(proxyLeadsDir, { recursive: true, force: true });
  }

  console.log('\nStatic file containment');
  const rawPath = (send) => new Promise((resolve, reject) => {
    const u = new URL(BASE);
    const request = require('http').request({
      hostname: u.hostname, port: u.port, path: send, method: 'GET', headers: { 'User-Agent': RUN_ID }
    }, (response) => {
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
  const escapes = [
    '/css/../server.js',
    '/css/..%2f..%2fserver.js',
    '/images/%2e%2e%2f%2e%2e%2fpackage.json',
    '/js/%2e%2e/%2e%2e/lib/shopify/client.js',
    '/css/%2e%2e%2f%2e%2e%2f.env',
    '/css/%00/etc/passwd'
  ];
  for (const send of escapes) {
    const got = await rawPath(send);
    const leaked = /"engines"|require\('http'\)|SHOPIFY_STOREFRONT_ACCESS_TOKEN|root:/.test(got.body);
    expect(`"${send}" serves nothing outside public/`,
      (got.status === 404 || got.status === 400) && !leaked, `${got.status}${leaked ? ' — LEAKED SOURCE' : ''}`);
  }
  const realAsset = await rawPath('/css/main.css');
  expect('a real asset still serves', realAsset.status === 200 && realAsset.body.length > 1000, String(realAsset.status));
  const encodedAsset = await rawPath('/images/gift-card.svg');
  expect('a percent-encoded-but-legitimate path still serves', encodedAsset.status === 200, String(encodedAsset.status));

  console.log('\nHealth telemetry');
  const health = await (await fetch(BASE + '/healthz')).json();
  expect('/healthz reports the lead sink honestly',
    health.leads && typeof health.leads.writable === 'boolean' && typeof health.leads.writeFailures === 'number',
    JSON.stringify(health.leads));
  expect('/healthz reports proxy trust',
    health.proxy && typeof health.proxy.trustForwardedHeaders === 'boolean', JSON.stringify(health.proxy));
  expect('a leaked lead write is never counted on a healthy sink',
    health.leads.writable === true && health.leads.writeFailures === 0, JSON.stringify(health.leads));

  console.log('\nOutput encoding (XSS)');
  const payload = '<script>window.__xss=1</script>" onmouseover="alert(1)';
  const reflected = await req('/search?q=' + encodeURIComponent(payload));
  expect('a reflected search term cannot inject markup',
    !reflected.text.includes('<script>window.__xss=1</script>') && !/ onmouseover="alert\(1\)/.test(reflected.text));
  const xssPost = await fetch(BASE + '/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'User-Agent': RUN_ID },
    body: JSON.stringify({ name: payload, email: 'xss@example.com', message: payload })
  });
  const xssBody = await xssPost.text();
  expect('stored payloads are stored escaped, never echoed raw', !xssBody.includes('<script>window.__xss=1</script>'));

  console.log('\nCookies');
  const cartCookie = cartSetCookie;
  expect('the cart cookie is HttpOnly', /httponly/i.test(cartCookie), cartCookie.slice(0, 60));
  expect('the cart cookie is SameSite=Lax', /samesite=lax/i.test(cartCookie));
  expect('the CSRF cookie is readable by page JS (double-submit needs it)', !/httponly/i.test(csrfCookie));

  console.log('\nPerformance + caching');
  const brRes = await rawGet('/', { acceptEncoding: 'br' });
  const gzRes = await rawGet('/', { acceptEncoding: 'gzip' });
  const plainRes = await rawGet('/', { acceptEncoding: 'identity' });
  expect('HTML is brotli-compressed on the wire',
    brRes.headers['content-encoding'] === 'br' && brRes.bytes < plainRes.bytes / 3,
    `${plainRes.bytes} → ${brRes.bytes} bytes`);
  expect('gzip is offered to clients without brotli',
    gzRes.headers['content-encoding'] === 'gzip' && gzRes.bytes < plainRes.bytes / 2,
    `${plainRes.bytes} → ${gzRes.bytes} bytes`);
  expect('compressed responses vary on Accept-Encoding', /accept-encoding/i.test(String(brRes.headers.vary)));
  expect('HTML is not shared-cache content', /private|no-store/.test(String(plainRes.headers['cache-control']) || ''));
  const cssRes = await fetch(BASE + '/css/main.css', { headers: { 'User-Agent': RUN_ID } });
  const etag = cssRes.headers.get('etag');
  expect('static assets carry an ETag', !!etag, String(etag));
  const condRes = await fetch(BASE + '/css/main.css', { headers: { 'If-None-Match': etag || '', 'User-Agent': RUN_ID } });
  expect('a conditional request answers 304', condRes.status === 304, String(condRes.status));

  console.log('\nSEO hygiene');
  const searchPage = await req('/search?q=hoodie');
  expect('internal search results are noindex', /name="robots"[^>]*noindex/i.test(searchPage.text));
  const cartIndex = await req('/cart');
  expect('the cart is noindex', /name="robots"[^>]*noindex/i.test(cartIndex.text));
  expect('the home page is indexable and canonical',
    /<link rel="canonical" href="https:\/\//.test(home.text) && !/name="robots"[^>]*noindex/i.test(home.text));

  /* -------------------------------------------------------------- summary */
  if (stopServer) await stopServer();
  console.log(`\n${'─'.repeat(48)}\n  ${pass} passed, ${fail} failed\n`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach(f => console.log('  • ' + f));
    process.exitCode = 1;
  }
})().catch(err => { console.error(err); process.exit(1); });
