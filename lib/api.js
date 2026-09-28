'use strict';
/**
 * api.js — JSON endpoints used by the storefront's client-side layer.
 *
 * Commerce flows (cart, search, quick view, buy-now) go to Shopify through
 * lib/shopify. Lead captures (newsletter, contact, back-in-stock alerts,
 * review submissions) go to the local leads store — non-commerce by design.
 * Every cart response carries the freshly read cart so the UI never guesses.
 */
const settings = require('./settings');
const leads = require('./leads');
const cartLib = require('./cart');
const catalog = require('./shopify/catalog');
const personalize = require('./personalize');
const style = require('./style');
const fit = require('./fit');
const layout = require('./layout');
const ui = require('./ui');
const { makeLimiter } = require('./ratelimit');
const { nonceAttr } = require('./security');

const limiter = makeLimiter();

/**
 * Per-route rate limits.
 *
 * Commerce endpoints get generous-but-bounded limits; the endpoints that can be
 * abused to enumerate something (discount codes) or to spam a person
 * (newsletter, contact, reviews) get tight ones. Every rejection carries
 * Retry-After so well-behaved clients back off instead of hammering.
 */
const RATES = {
  'api':            { windowMs: 60_000, max: 120 },
  'cart.read':      { windowMs: 60_000, max: 120 },
  'cart.add':       { windowMs: 60_000, max: 45 },
  'cart.update':    { windowMs: 60_000, max: 60 },
  'cart.remove':    { windowMs: 60_000, max: 60 },
  'cart.discount':  { windowMs: 60_000, max: 10 },   // discount-code guessing
  'cart.note':      { windowMs: 60_000, max: 30 },
  'buy-now':        { windowMs: 60_000, max: 20 },
  'search':         { windowMs: 60_000, max: 60 },   // also protects the catalog cache
  'notify':         { windowMs: 60_000, max: 12 },
  'newsletter':     { windowMs: 60_000, max: 6 },
  'contact':        { windowMs: 600_000, max: 3 },
  'reviews':        { windowMs: 600_000, max: 3 },
  'review.vote':    { windowMs: 60_000, max: 30 },
  'fit':            { windowMs: 60_000, max: 30 },
  'monogram':       { windowMs: 60_000, max: 60 },
  'style':          { windowMs: 60_000, max: 60 },
  'quickview':      { windowMs: 60_000, max: 90 }
};

function routeKey(pathname, method) {
  if (pathname.startsWith('/reviews/helpful/')) return 'review.vote';
  if (pathname.startsWith('/quickview/')) return 'quickview';
  const table = {
    '/cart': 'cart.read',
    '/cart/add': 'cart.add',
    '/cart/update': 'cart.update',
    '/cart/remove': 'cart.remove',
    '/cart/discount': 'cart.discount',
    '/cart/note': 'cart.note',
    '/cart/shipping': 'cart.note',
    '/buy-now': 'buy-now',
    '/search': 'search',
    '/notify': 'notify',
    '/newsletter': 'newsletter',
    '/contact': 'contact',
    '/reviews': 'reviews',
    '/fit': 'fit',
    '/monogram': 'monogram',
    '/style': 'style'
  };
  return table[pathname] || 'api';
}

/** Returns true when the request may proceed; otherwise sends a 429. */
function allow(ctx, key) {
  const preset = RATES[key] || RATES.api;
  if (limiter.allow(ctx.req, key, preset)) return true;
  const retryAfter = Math.max(1, Math.ceil(preset.windowMs / 1000));
  const body = JSON.stringify({ ok: false, error: 'Too many requests — please slow down and try again shortly.' });
  ctx.res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Retry-After': String(retryAfter),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  ctx.res.end(body);
  return false;
}

function payload(ctx) {
  const cart = ctx.cart;
  return {
    ok: true,
    cart: serializeCart(cart),
    html: {
      count: String(cart.count),
      drawer: layout.cartBody(cart, ctx.chrome.products),
      subtotal: ui.money(cart.subtotal),
      total: ui.money(cart.total),
      discountLine: cart.discount ? `<span>Discount · ${ui.esc(cart.discount.code)}</span><strong>−${ui.money(cart.discountAmount)}</strong>` : '',
      shipMsg: cart.freeShipping.qualified
        ? `${ui.icon('check', { size: 15 })} You have earned free standard shipping.`
        : cart.freeShipping.threshold ? `You are ${ui.money(cart.freeShipping.remaining)} away from free standard shipping.` : '',
      shipPct: cart.freeShipping.threshold ? Math.min(100, Math.round(((cart.freeShipping.threshold - cart.freeShipping.remaining) / cart.freeShipping.threshold) * 100)) : 0
    }
  };
}

function serializeCart(cart) {
  return {
    id: cart.id, count: cart.count, subtotal: cart.subtotal, discountAmount: cart.discountAmount,
    discountCode: cart.discount ? cart.discount.code : null,
    // shipping and taxes are Shopify's job — never estimated by the storefront
    shipping: null, tax: null,
    total: cart.total, currency: cart.currency, checkoutUrl: cart.checkoutUrl || null,
    lines: cart.lines.map(l => ({
      id: l.id, title: l.title, variantId: l.merchandiseId || l.variantId || null, quantity: l.quantity,
      price: l.price, color: l.color, size: l.size, stock: l.stock,
      personalization: l.personalization ? { text: l.personalization.text, price: l.personalization.price, label: l.personalization.label } : null
    }))
  };
}

function fail(res, error, status = 400, extra = {}) {
  const body = JSON.stringify({ ok: false, error, ...extra });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  res.end(body);
}

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  res.end(body);
}

async function handle(ctx) {
  const { req, res, url, query } = ctx;
  const pathname = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method.toUpperCase();

  // Per-route rate limiting (the server already applied the global write limit).
  if (!allow(ctx, routeKey(pathname, method))) return;

  try {
    /* ------------------------------- cart ------------------------------- */
    if (pathname === '/cart' && method === 'GET') {
      return json(res, payload(ctx));
    }
    if (pathname === '/cart/add' && method === 'POST') {
      const body = await ctx.body();
      if (Array.isArray(body.items) && body.items.length) {
        const batch = await cartLib.addItems(req, ctx.res, body.items);
        if (!batch.ok && batch.failed.length) return fail(res, batch.failed[0].error, 400, { failed: batch.failed });
        leads.logActivity('storefront', 'cart.addBatch', `${batch.added} of ${body.items.length} pieces`);
        ctx.cart = batch.cart;
        const out = payload(ctx);
        out.added = batch.added;
        if (batch.failed.length) out.failed = batch.failed;
        return json(res, out);
      }
      const result = await cartLib.addItem(req, ctx.res, body.variantId, Number(body.quantity) || 1, { personalization: body.personalization });
      if (!result.ok) return fail(res, result.error, 400, result.field ? { field: result.field } : {});
      leads.logActivity('storefront', 'cart.add', `${body.variantId} ×${Number(body.quantity) || 1}`);
      ctx.cart = result.cart;
      const out = payload(ctx);
      out.monogrammed = !!result.monogrammed;
      return json(res, out);
    }
    if (pathname === '/cart/update' && method === 'POST') {
      const body = await ctx.body();
      const result = await cartLib.updateItem(req, res, body.lineId, Number(body.quantity));
      if (!result.ok) return fail(res, result.error, 400, result.max ? { max: result.max } : {});
      ctx.cart = result.cart;
      return json(res, payload(ctx));
    }
    if (pathname === '/cart/remove' && method === 'POST') {
      const body = await ctx.body();
      const result = await cartLib.removeItem(req, res, body.lineId);
      if (!result.ok) return fail(res, result.error);
      ctx.cart = result.cart;
      return json(res, payload(ctx));
    }
    if (pathname === '/cart/discount' && method === 'POST') {
      const body = await ctx.body();
      const result = await cartLib.applyDiscount(req, res, body.remove ? '' : body.code);
      if (!result.ok) return fail(res, result.error);
      ctx.cart = result.cart;
      const out = payload(ctx);
      if (result.code) out.discount = { code: result.code };
      return json(res, out);
    }
    if (pathname === '/cart/note' && method === 'POST') {
      const body = await ctx.body();
      const result = await cartLib.setNotes(req, res, { giftNote: body.giftNote, note: body.note });
      if (!result.ok) return fail(res, result.error);
      ctx.cart = result.cart;
      return json(res, payload(ctx));
    }
    if (pathname === '/cart/shipping' && method === 'POST') {
      // legacy endpoint: shipping is now calculated by Shopify at checkout.
      return json(res, payload(ctx));
    }

    /* ------------------------------ buy now ----------------------------- */
    if (pathname === '/buy-now' && method === 'POST') {
      const body = await ctx.body();
      let cartIdHint = ctx.cart.id;
      if (!ctx.cart.count) {
        const result = await cartLib.addItem(req, ctx.res, body.variantId, Number(body.quantity) || 1, { personalization: body.personalization });
        if (!result.ok) return fail(res, result.error, 400);
        cartIdHint = result.cart.id;
      }
      const checkoutUrl = await cartLib.checkoutUrlFor(req, cartIdHint);
      if (!checkoutUrl) return fail(res, 'Could not start a Shopify checkout for this cart.', 502);
      leads.logActivity('storefront', 'checkout.buyNow', body.variantId || '');
      return json(res, { ok: true, checkoutUrl });
    }

    /* ------------------------------ search ------------------------------ */
    if (pathname === '/search' && method === 'GET') {
      const q = (query.q || '').trim();
      if (!q) return json(res, { ok: true, products: [], collections: [], articles: [] });
      const [products, articles] = await Promise.all([
        catalog.searchProducts(q, 6).catch(() => []),
        catalog.getArticles().catch(() => [])
      ]);
      const ql = q.toLowerCase();
      const prodOut = (products.length ? products : ctx.chrome.products.filter(p =>
        `${p.title} ${p.tagline} ${p.type} ${p.vendor} ${p.tags.join(' ')}`.toLowerCase().includes(ql))).slice(0, 6)
        .map(p => ({
          handle: p.handle, title: p.title, type: p.type, price: ui.money(p.price),
          compareAt: p.compareAtPrice ? ui.money(p.compareAtPrice) : null,
          image: p.images[0] ? p.images[0].src : '', url: `/products/${p.handle}`,
          available: p.inventoryQuantity > 0
        }));
      const collections = ctx.chrome.collections
        .filter(c => `${c.title} ${c.description}`.toLowerCase().includes(ql)).slice(0, 4)
        .map(c => ({ handle: c.handle, title: c.title, url: `/collections/${c.handle}`, count: c.productHandles.length }));
      const articleOut = articles.filter(p => `${p.title} ${p.excerpt}`.toLowerCase().includes(ql)).slice(0, 3)
        .map(p => ({ handle: p.handle, title: p.title, url: `/blogs/journal/${p.handle}`, excerpt: p.excerpt }));
      return json(res, { ok: true, products: prodOut, collections, articles: articleOut });
    }

    /* ------------------------- back in stock alerts ---------------------- */
    if (pathname === '/notify' && method === 'POST') {
      const body = await ctx.body();
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) return fail(res, 'That email address does not look right.');
      const found = await catalog.findVariant(body.variantId);
      if (!found) return fail(res, 'That product is no longer available.', 404);
      const { product, variant } = found;
      if (variant.stock > 0) return fail(res, 'That size is back in stock — you can order it now.');
      // Uniform response regardless of prior signup so callers cannot enumerate
      // which emails are on the waitlist for a variant.
      const existing = leads.find('backInStock', n => n.email === email && n.variantId === variant.id && n.status === 'waiting');
      if (!existing) {
        leads.insert('backInStock', {
          email, variantId: variant.id, sku: variant.sku,
          productId: product.id, handle: product.handle, title: product.title,
          color: variant.color, size: variant.size,
          status: 'waiting', source: 'product page'
        });
        leads.logActivity('storefront', 'stock.notify', `${email} → ${product.handle} ${variant.size}`);
      }
      return json(res, { ok: true, message: `We will email ${email} the moment ${product.title} in ${variant.size} lands.` });
    }

    /* ----------------------------- fit finder ---------------------------- */
    if (pathname === '/fit' && method === 'POST') {
      const body = await ctx.body();
      const product = await catalog.getProductByHandle(body.handle);
      if (!product) return fail(res, 'Product not found', 404);
      const result = fit.recommend(product, {
        height: body.height, weight: body.weight, units: body.units,
        usualSize: body.usualSize, preference: body.preference
      });
      if (!result.ok) return fail(res, result.error);
      return json(res, { ok: true, fit: result });
    }

    /* -------------------------- monogram preview ------------------------- */
    if (pathname === '/monogram' && method === 'POST') {
      const body = await ctx.body();
      const product = await catalog.getProductByHandle(body.handle);
      if (!product) return fail(res, 'Product not found', 404);
      const serviceProduct = await catalog.getServiceProduct(settings.get().personalization.serviceProductHandle).catch(() => null);
      const config = personalize.configFor(product, { serviceProduct });
      if (!config) return fail(res, 'This piece cannot be monogrammed.', 422);
      const text = personalize.clean(body.text, config);
      const valid = personalize.validate(product, { text: body.text }, { serviceProduct });
      return json(res, {
        ok: true,
        text,
        valid: valid.ok,
        error: valid.ok ? null : valid.error,
        price: config.chargedVia === 'service-product' ? config.price : 0,
        priceLabel: config.chargedVia === 'service-product' ? ui.money(config.price) : '',
        chargedVia: config.chargedVia,
        placement: config.placement,
        maxChars: config.maxChars,
        remaining: Math.max(0, config.maxChars - text.length),
        note: config.note
      });
    }

    /* ---------------------------- style it with -------------------------- */
    if (pathname === '/style' && method === 'GET') {
      const product = await catalog.getProductByHandle(query.handle || '');
      if (!product) return fail(res, 'Product not found', 404);
      const recommended = await catalog.recommendations(product.id, 6).catch(() => []);
      const look = style.lookFor(product, Number(query.limit) || 3, ctx.chrome.products, recommended);
      return json(res, {
        ok: true,
        look: look.map(p => ({
          handle: p.handle, title: p.title, type: p.type, price: ui.money(p.price),
          image: p.images[0] ? p.images[0].src : '', url: `/products/${p.handle}`,
          available: p.inventoryQuantity > 0,
          variant: ((p.variants.find(v => v.stock > 0) || p.variants[0]) || { id: '' }).id
        }))
      });
    }

    /* ----------------------------- quick view ---------------------------- */
    if (pathname.startsWith('/quickview/') && method === 'GET') {
      const handle = decodeURIComponent(pathname.replace('/quickview/', ''));
      const product = await catalog.getProductByHandle(handle);
      if (!product) return fail(res, 'Product not found', 404);
      return json(res, { ok: true, html: quickViewHtml(product) });
    }

    /* --------------------------- newsletter --------------------------- */
    if (pathname === '/newsletter' && method === 'POST') {
      const body = await ctx.body();
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 'Enter a valid email address.');
      const existing = leads.find('subscribers', s => s.email === email);
      if (existing) { existing.status = 'subscribed'; leads.save(); }
      else leads.insert('subscribers', { email, source: body.source || 'footer', status: 'subscribed' });
      leads.logActivity('storefront', 'subscriber.created', email);
      return json(res, { ok: true, message: 'You are on the list. Check your inbox for the 10% code — try WELCOME10 at checkout.' });
    }

    /* ------------------------------ contact ------------------------------ */
    if (pathname === '/contact' && method === 'POST') {
      const body = await ctx.body();
      const required = ['name', 'email', 'message'];
      for (const field of required) if (!String(body[field] || '').trim()) return fail(res, `Please complete the ${field} field.`);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return fail(res, 'Enter a valid email address.');
      const message = leads.insert('messages', {
        name: String(body.name).slice(0, 120), email: String(body.email).slice(0, 160),
        topic: String(body.topic || 'Something else').slice(0, 60), orderNumber: String(body.orderNumber || '').slice(0, 40),
        message: String(body.message).slice(0, 4000), status: 'open', source: 'contact form'
      });
      leads.logActivity('storefront', 'message.created', `${message.email} — ${message.topic}`);
      return json(res, { ok: true, message: 'Message received. A human replies within one business day — usually much sooner.' });
    }

    /* ------------------------- reviews & helpful ------------------------- */
    if (pathname === '/reviews' && method === 'POST') {
      const body = await ctx.body();
      const product = await catalog.getProductByHandle(body.handle);
      if (!product) return fail(res, 'Unknown product.', 404);
      if (!body.author || !body.email || !body.body) return fail(res, 'Name, email and review text are required.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) return fail(res, 'Enter a valid email address.');
      // Captured locally for moderation / sync into the store's reviews app.
      leads.insert('reviews', {
        productHandle: product.handle, productTitle: product.title,
        rating: Math.max(1, Math.min(5, Number(body.rating) || 5)),
        title: String(body.title || 'Verified purchase').slice(0, 140), body: String(body.body).slice(0, 2000),
        author: String(body.author).slice(0, 80), email: String(body.email).slice(0, 160),
        status: 'pending', helpful: 0, reply: null
      });
      leads.logActivity('storefront', 'review.submitted', `${product.title} — pending moderation`);
      return json(res, { ok: true, message: 'Thanks — your review is with the studio for moderation and usually appears within a day.' });
    }
    if (pathname.startsWith('/reviews/helpful/') && method === 'POST') {
      const id = decodeURIComponent(pathname.replace('/reviews/helpful/', ''));
      const [handle, idx] = id.split(':');
      const product = await catalog.getProductByHandle(handle);
      if (!product) return fail(res, 'Review not found', 404);
      const review = (product.reviews || [])[Number(idx)];
      if (!review) return fail(res, 'Review not found', 404);
      const vote = leads.insert('activity', { actor: 'storefront', action: 'review.helpful', detail: id });
      const stored = leads.all('activity').filter(a => a.action === 'review.helpful' && a.detail === id).length;
      return json(res, { ok: true, helpful: (review.helpful || 0) + stored });
    }

    return fail(res, `No API route for ${method} ${pathname}`, 404);
  } catch (err) {
    console.error('[api]', method, pathname, err);
    return fail(res, 'Unexpected error talking to the store. Please try again.', 502);
  }
}

function quickViewHtml(product) {
  const colors = product.options.find(o => o.name === 'Colour').values;
  const sizes = product.options.find(o => o.name === 'Size').values;
  const first = product.variants.find(v => v.stock > 0) || product.variants[0];
  return `<div class="quickview__body">
    <div class="quickview__media">
      <img src="${ui.attr(product.images[0] ? product.images[0].src : '')}" alt="${ui.attr(product.title)}" width="700" height="800">
      <div class="quickview__thumbs">
        ${product.images.map(i => `<img src="${ui.attr(i.src)}" alt="" width="90" height="110" loading="lazy">`).join('')}
      </div>
    </div>
    <div class="quickview__info">
      <p class="eyebrow">${ui.esc(product.vendor)} · ${ui.esc(product.type)}</p>
      <h2 id="qv-title">${ui.esc(product.title)}</h2>
      <div class="quickview__rating">${ui.stars(product.rating.avg, { count: product.rating.count, size: 14 })}</div>
      <p class="quickview__price">${ui.priceBlock(product, { size: 'lg' })}</p>
      <p class="quickview__copy">${ui.esc(product.tagline)} — ${ui.esc((product.features || [])[0] || '')}</p>
      <form class="product-form product-form--qv" data-add-form data-product="${ui.attr(product.handle)}">
        <fieldset class="picker">
          <legend>Colour: <strong data-color-label>${ui.esc(first.color)}</strong></legend>
          <div class="swatch-row">
            ${colors.map(c => `<button type="button" class="swatch swatch--lg ${c.name === first.color ? 'is-active' : ''}" style="--sw:${ui.attr(c.hex)}" data-color="${ui.attr(c.name)}" aria-label="${ui.attr(c.name)}" aria-pressed="${c.name === first.color}"></button>`).join('')}
          </div>
        </fieldset>
        <fieldset class="picker">
          <legend>Size: <strong data-size-label>${ui.esc(first.size)}</strong></legend>
          <div class="size-row">
            ${sizes.map(s => {
              const variant = product.variants.find(v => v.color === first.color && v.size === s.name);
              const out = !variant || variant.stock <= 0;
              return `<button type="button" class="size ${out ? 'is-out' : ''} ${variant && variant.id === first.id ? 'is-active' : ''}" data-size="${ui.attr(s.name)}" data-variant="${variant ? ui.attr(variant.id) : ''}" data-stock="${variant ? variant.stock : 0}" ${out ? 'disabled' : ''} aria-pressed="false">${ui.esc(s.name)}</button>`;
            }).join('')}
          </div>
        </fieldset>
        <div class="product-form__stock"><span class="stock-pill" data-stock-pill>${first.stock > 5 ? 'In stock' : first.stock > 0 ? `Only ${first.stock} left` : 'Sold out'}</span></div>
        <input type="hidden" name="variantId" value="${ui.attr(first.id)}" data-variant-input>
        <div class="product-form__buy">
          <div class="qty qty--lg" data-qty>
            <button type="button" data-qty-dec aria-label="Decrease quantity">−</button>
            <input type="number" name="quantity" value="1" min="1" max="20" data-qty-input aria-label="Quantity">
            <button type="button" data-qty-inc aria-label="Increase quantity">+</button>
          </div>
          <button class="btn btn--primary btn--lg" type="submit" data-add-submit>Add to cart</button>
        </div>
        <p class="form-msg" data-form-msg role="status"></p>
      </form>
      <a class="link-arrow" href="/products/${ui.attr(product.handle)}">Full product details ${ui.icon('arrow', { size: 15 })}</a>
      <script type="application/json" data-product-json="${ui.attr(product.handle)}"${nonceAttr()}>${JSON.stringify({ handle: product.handle, title: product.title, variants: product.variants.map(v => ({ id: v.id, color: v.color, size: v.size, price: v.price, compareAtPrice: v.compareAtPrice, stock: v.stock, sku: v.sku, image: v.image })), images: product.images.map(i => i.src) })}</script>
    </div>
  </div>`;
}

module.exports = { handle, serializeCart, quickViewHtml };
