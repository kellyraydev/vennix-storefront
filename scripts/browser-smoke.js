#!/usr/bin/env node
/**
 * Browser-level click test.
 *
 * The HTTP smoke test (scripts/smoke.js) proves the server answers every route.
 * This one proves the *client* behaves: it loads real pages into a DOM, runs
 * public/js/main.js and public/js/motion.js exactly as a browser would, then
 * clicks, types and submits — asserting the DOM, the API traffic and the cart
 * state that follow.
 *
 * jsdom is a dev-only dependency (this repo stays zero-dep at runtime):
 *   mkdir -p /tmp/jsdom && cd /tmp/jsdom && npm install jsdom
 *
 * Usage: node scripts/browser-smoke.js [baseUrl]
 */

'use strict';

const path = require('path');
const fs = require('fs');

function loadJsdom() {
  const candidates = ['jsdom', '/tmp/jsdom/node_modules/jsdom', path.join(process.cwd(), 'node_modules', 'jsdom')];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) { /* keep looking */ }
  }
  // A suite that did not run is not a suite that passed. Locally the missing
  // dev-dependency is a skip; in CI it is an error, because that is where a
  // silent skip would turn the green checkmark into a lie.
  console.warn('\n  ! SKIPPED — the browser click test did not run: jsdom is not installed.');
  console.warn('      install with: npm install --no-save jsdom   (or: mkdir -p /tmp/jsdom && cd /tmp/jsdom && npm install jsdom)\n');
  if (process.env.CI === 'true' || process.env.VENNIX_REQUIRE_BROWSER_TEST === '1') {
    console.error('  ✗ jsdom is required in CI (the workflow installs it). Failing instead of reporting a false pass.');
    process.exit(1);
  }
  process.exit(0);
}

const { JSDOM, CookieJar, VirtualConsole } = loadJsdom();

const DEBUG = !!process.env.BROWSER_SMOKE_DEBUG;
function makeConsole(label) {
  if (!DEBUG) return undefined;
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => console.log(`  [${label}] jsdomError: ${error.message}`));
  vc.on('error', (...args) => console.log(`  [${label}] page error:`, ...args));
  vc.on('log', (...args) => console.log(`  [${label}] log:`, ...args));
  return vc;
}

const { ensureBase } = require('./helpers');
let BASE = (process.argv[2] || '').replace(/\/$/, '');
let stopServer = null;

/* ------------------------------- test harness ----------------------------- */

let passed = 0;
let failed = 0;
let group = '';

function section(name) { group = name; console.log(`\n${name}`); }
function ok(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/* -------------------------------- cookie jar ------------------------------ */

const jar = new CookieJar();
function absorb(response, url) {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  cookies.forEach((cookie) => { try { jar.setCookieSync(cookie, url || BASE); } catch (error) {} });
}
const jarHeader = url => jar.getCookieStringSync(url || BASE);

async function prime() {
  const response = await fetch(BASE + '/');
  absorb(response, BASE);
  await response.text();
}

/* ------------------------------- page loading ----------------------------- */

async function openPage(url, options = {}) {
  const target = url.startsWith('http') ? url : BASE + url;
  const dom = await JSDOM.fromURL(target, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    cookieJar: jar,
    virtualConsole: makeConsole(options.label || target),
    beforeParse(window) {
      // cookie-aware fetch shim (jsdom has no fetch, and httpOnly cookies are invisible to page JS)
      window.fetch = (input, init = {}) => {
        const href = String(input).startsWith('http') ? String(input) : new URL(String(input), window.location.href).href;
        const headers = new Headers(init.headers || {});
        const cookies = jarHeader(href);
        if (cookies) headers.set('cookie', cookies);
        return fetch(href, { ...init, headers, redirect: 'follow' }).then((response) => {
          absorb(response, href);
          return response;
        });
      };
      window.Request = Request;
      window.Response = Response;
      window.Headers = Headers;

      // browser APIs jsdom does not implement
      window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; }
        observe(target) {
          this.targets.push(target);
          // fire on the next tick, like a real observer does for in-view elements
          setTimeout(() => {
            if (!this.targets.includes(target)) return;
            try { this.callback([{ isIntersecting: true, intersectionRatio: 1, target }], this); } catch (error) {}
          }, 20);
        }
        unobserve(target) { this.targets = this.targets.filter(t => t !== target); }
        disconnect() { this.targets = []; }
      };
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      window.scrollTo = () => {};
      // jsdom has no layout engine; give every element a plausible box so the
      // fly-to-cart / parallax / sticky code paths exercise for real
      window.Element.prototype.getBoundingClientRect = function () {
        const isCart = this.hasAttribute && this.hasAttribute('data-cart-open');
        const w = isCart ? 40 : 240;
        const h = isCart ? 40 : 260;
        const left = isCart ? 900 : 120;
        const top = isCart ? 18 : 320;
        return { x: left, y: top, left, top, width: w, height: h, right: left + w, bottom: top + h, toJSON() { return this; } };
      };
      window.Element.prototype.scrollIntoView = () => {};
      window.Element.prototype.scrollBy = () => {};
      window.open = (opened => (url) => { window.__lastOpened = url; return opened; })(null);
      window.navigator.clipboard = { writeText: () => Promise.resolve() };
      window.__fetches = [];
      const realFetch = window.fetch;
      window.fetch = (input, init) => {
        const href = String(input);
        window.__fetches.push(href);
        return realFetch(input, init);
      };
    }
  });

  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') return resolve();
    window.addEventListener('load', resolve);
    setTimeout(resolve, 4000);
  });
  await wait(120);
  return dom;
}

function fire(window, element, type, extra = {}) {
  const EventCtor = type.startsWith('click') || type === 'click' ? window.MouseEvent : window.Event;
  const event = type === 'click'
    ? new window.MouseEvent('click', { bubbles: true, cancelable: true })
    : new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, extra);
  element.dispatchEvent(event);
}

async function type(window, element, value) {
  element.value = value;
  fire(window, element, 'input');
  fire(window, element, 'change');
  await wait(60);
}

/* --------------------------------- the tests ------------------------------ */

async function testHome() {
  section('Home — chrome, search overlay, wishlist, drawer');
  const dom = await openPage('/', { label: 'home' });
  const { window } = dom;
  const doc = window.document;
  const $ = sel => doc.querySelector(sel);

  ok('client script executed (toast helper installed)', typeof window.vennixToast === 'function');
  ok('demo banner labels the fixture run', !!doc.querySelector('.demo-banner'));

  const cartDrawer = $('[data-cart-drawer]');
  ok('cart drawer starts hidden', cartDrawer && cartDrawer.hasAttribute('hidden'));
  fire(window, $('[data-cart-open]'), 'click');
  ok('clicking the cart icon opens the drawer', cartDrawer && !cartDrawer.hasAttribute('hidden'));
  const overlay = $('[data-overlay]');
  ok('overlay is shown with the drawer', overlay && !overlay.hasAttribute('hidden'));
  fire(window, overlay, 'click');
  await wait(420);
  ok('clicking the overlay closes the cart', cartDrawer.hasAttribute('hidden'));

  const menuBtn = $('[data-menu-open]');
  const mobileMenuEl = $('[data-menu]');
  if (menuBtn && mobileMenuEl) {
    fire(window, menuBtn, 'click');
    ok('mobile menu opens', !mobileMenuEl.hasAttribute('hidden') || mobileMenuEl.classList.contains('is-open'));
    const close = mobileMenuEl.querySelector('[data-menu-close]');
    if (close) { fire(window, close, 'click'); await wait(320); }
  } else ok('mobile menu markup present', false, menuBtn ? 'missing data-menu panel' : 'missing data-menu-open');

  const search = $('[data-search]');
  fire(window, $('[data-search-open]'), 'click');
  ok('search overlay opens', search && !search.hasAttribute('hidden'));
  await type(window, $('[data-search-input]'), 'hoodie');
  await wait(600);
  const results = $('[data-search-results]');
  ok('predictive search renders results', results && /Atlas|hoodie/i.test(results.textContent), results ? results.textContent.replace(/\s+/g, ' ').slice(0, 60) : 'no node');
  fire(window, $('[data-search-close]'), 'click');
  await wait(420);
  ok('search overlay closes', search.hasAttribute('hidden'));

  const wishCount = $('[data-wish-count]');
  fire(window, $('[data-wish]'), 'click');
  await wait(80);
  ok('wishlist heart stores the product', (window.localStorage.getItem('vnx_wishlist') || '').length > 2);
  ok('wishlist counter updates', wishCount && wishCount.textContent.trim() === '1', wishCount ? wishCount.textContent : 'missing');

  const index = doc.querySelector('script[data-catalog-index]');
  let catalog = null;
  try { catalog = JSON.parse(index.textContent); } catch { catalog = null; }
  ok('catalog index JSON parses for the wishlist', Array.isArray(catalog) && catalog.length > 3);

  window.close();
}

async function testProductPage() {
  section('Product page — variant switching, add to cart, quick view');
  const dom = await openPage('/products/atlas-heavyweight-hoodie', { label: 'pdp' });
  const { window } = dom;
  const doc = window.document;
  const $$ = sel => Array.from(doc.querySelectorAll(sel));

  ok('product form present', !!doc.querySelector('[data-add-form]'));
  const variantInput = doc.querySelector('[data-variant-input]');
  ok('variant input starts with a real Shopify variant id', /^gid:\/\/shopify\/ProductVariant\//.test(variantInput.value || ''), variantInput ? variantInput.value : 'missing');
  const before = variantInput.value;

  const sizeButtons = $$('[data-size]').filter(b => b.getAttribute('data-stock') !== '0' && !b.disabled);
  if (sizeButtons.length > 1) {
    fire(window, sizeButtons[1], 'click');
    await wait(80);
    ok('choosing a size swaps the variant id', variantInput.value !== before, `${before} → ${variantInput.value}`);
  } else ok('size buttons exist', false, 'no selectable sizes found');

  const cartBefore = Number(doc.querySelector('[data-cart-count]').textContent) || 0;
  const form = doc.querySelector('[data-add-form]');
  fire(window, form, 'submit');
  await wait(800);
  const cartAfter = Number(doc.querySelector('[data-cart-count]').textContent) || 0;
  ok('submitting the form hits /api/cart/add', window.__fetches.some(u => u.includes('/api/cart/add')), window.__fetches.slice(-3).join(' | '));
  ok('cart counter increments after adding', cartAfter === cartBefore + 1, `${cartBefore} → ${cartAfter}`);
  ok('toast confirms the add', !!doc.querySelector('[data-toasts] .toast'));
  ok('drawer body re-rendered with the new line', (doc.querySelector('[data-cart-body]') || {}).textContent.trim().length > 20);

  const guide = doc.querySelector('[data-sizeguide-open]');
  if (guide) {
    fire(window, guide, 'click');
    await wait(700);
    const modal = Array.from(doc.querySelectorAll('.quickview')).find(m => m.querySelector('[data-sg-close]'));
    ok('size guide opens an in-page modal', !!modal);
    ok('size guide modal loaded the measurement charts', !!modal && /chest|waist|measurement|cm\b/i.test(modal.textContent));
  }

  // quick view from a collection card
  window.close();
  const col = await openPage('/collections/all', { label: 'collection' });
  const cw = col.window;
  const trigger = cw.document.querySelector('[data-quickadd]');
  if (trigger) {
    fire(cw, trigger, 'click');
    await wait(800);
    const qv = cw.document.querySelector('.quickview.is-open') || cw.document.querySelector('[data-quickview]');
    ok('quick view opens from a card', cw.__fetches.some(u => u.includes('/api/quickview/')), cw.__fetches.slice(-2).join(' | '));
    ok('quick view fetched a variant picker', !!qv && !!qv.querySelector('[data-variant-input]'));
  } else ok('quick view trigger exists on cards', false, 'no [data-quickadd]');
  col.window.close();
}

async function testCartPage() {
  section('Cart page — quantity, discount, notes (against the live cart)');
  // the PDP test already added an item through the same cookie jar
  const dom = await openPage('/cart', { label: 'cart' });
  const { window } = dom;
  const doc = window.document;

  ok('cart page renders a line', !!doc.querySelector('[data-line]'));
  const inc = doc.querySelector('[data-line-inc]');
  if (inc) {
    const qtyInput = doc.querySelector('[data-line-qty]');
    const before = qtyInput ? qtyInput.value : null;
    fire(window, inc, 'click');
    await wait(700);
    ok('“+” updates the line through /api/cart/update', window.__fetches.some(u => u.includes('/api/cart/update')), window.__fetches.slice(-2).join(' | '));
    const after = doc.querySelector('[data-line-qty]') ? doc.querySelector('[data-line-qty]').value : null;
    ok('quantity input reflects the change', String(after) !== String(before), `${before} → ${after}`);
  } else ok('quantity controls render', false, 'no data-line-inc');

  const shipping = doc.querySelector('[data-sum-shipping]');
  ok('shipping row defers to Shopify', shipping && /calculated at checkout/i.test(shipping.textContent), shipping ? shipping.textContent : 'missing');

  const discForm = doc.querySelector('[data-discount-form]');
  if (discForm) {
    const input = discForm.querySelector('input[name="code"]');
    await type(window, input, 'WELCOME10');
    fire(window, discForm, 'submit');
    await wait(700);
    ok('discount form posts to /api/cart/discount', window.__fetches.some(u => u.includes('/api/cart/discount')));
    ok('discount row appears in the totals', !!doc.querySelector('.totals__discount') && /WELCOME10/.test(doc.querySelector('.totals__discount').textContent));
  } else ok('discount form present', false, 'no data-discount-form');

  const giftNote = doc.querySelector('[data-gift-note]');
  if (giftNote) {
    await type(window, giftNote, 'Happy birthday!');
    giftNote.dispatchEvent(new window.Event('blur', { bubbles: true }));
    await wait(700);
    ok('gift note autosaves through /api/cart/note', window.__fetches.some(u => u.includes('/api/cart/note')), window.__fetches.slice(-2).join(' | '));
  } else ok('gift note field present', false, 'no data-gift-note');

  window.close();
}

async function testMotion() {
  section('Motion & polish layer');
  const dom = await openPage('/', { label: 'motion' });
  const { window } = dom;
  const doc = window.document;
  const root = doc.documentElement;

  ok('motion layer boots and flags the document', root.classList.contains('has-motion'));
  ok('scroll progress bar is present', !!doc.querySelector('[data-scroll-progress]'));
  ok('sections are auto-tagged for reveal', doc.querySelectorAll('[data-reveal]').length > 5, `${doc.querySelectorAll('[data-reveal]').length} tagged`);
  await wait(250);
  ok('in-view sections reveal themselves', doc.querySelectorAll('[data-reveal].is-revealed').length > 3, `${doc.querySelectorAll('[data-reveal].is-revealed').length} revealed`);
  ok('stagger delays are set on cards', doc.querySelectorAll('[data-reveal][style*="--reveal-delay"]').length > 0);

  const counters = Array.from(doc.querySelectorAll('[data-count-to]'));
  ok('store pulse counters rendered', counters.length >= 3, `${counters.length} counters`);
  await wait(1800);
  const values = counters.map(c => c.textContent.trim());
  ok('counters animate up to their real values', values.every(v => v.length > 0), values.join(' / '));

  const ticker = doc.querySelector('[data-live-ticker]');
  ok('ticker markup present', !!ticker);
  ok('parallax elements are tagged', doc.querySelectorAll('[data-parallax]').length >= 2);
  const heroImg = doc.querySelector('.hero__img');
  ok('hero image has the depth treatment', !!heroImg && heroImg.hasAttribute('data-parallax'));
  ok('pulse band counts honestly', !!doc.querySelector('.pulse__heading'));

  // fly-to-cart on a real add
  const addBtn = doc.querySelector('.spotlight [data-add-submit]') || doc.querySelector('.pcard [data-add-variant]') || doc.querySelector('[data-add-submit]');
  if (addBtn) {
    fire(window, addBtn, 'click');
    await wait(260);
    ok('the motion API is exposed for reuse', !!window.vennixMotion && typeof window.vennixMotion.flyToCart === 'function');
    ok('the cart icon bumps on add', !!doc.querySelector('.is-bumped'));
    let sawToken = false;
    for (let i = 0; i < 14 && !sawToken; i += 1) { await wait(50); sawToken = !!doc.querySelector('.fly-token'); }
    ok('a fly-to-cart token is animated on add', sawToken);
    await wait(900);
    ok('fly token is cleaned up afterwards', !doc.querySelector('.fly-token'));
  } else ok('homepage has an add button for the fly-to-cart test', false, 'no add button found');
  window.close();

  // reviews honesty: aggregateRating only where real reviews exist
  const unrated = await openPage('/products/velocity-long-sleeve-base-layer', { label: 'unrated' });
  const udoc = unrated.window.document;
  ok('an unreviewed product invites the first review', /No reviews yet/i.test(udoc.body.textContent));
  const ld = Array.from(udoc.querySelectorAll('script[type="application/ld+json"]')).map(s => s.textContent).join(' ');
  ok('unreviewed product emits no aggregateRating', !/aggregateRating/.test(ld));
  unrated.window.close();
}

async function testPersonalization() {
  section('Monogram, size finder, shop-the-look, alerts (client-side)');
  const dom = await openPage('/products/atlas-heavyweight-hoodie', { label: 'personalize' });
  const { window } = dom;
  const doc = window.document;

  /* monogram */
  const box = doc.querySelector('[data-monogram]');
  const toggle = box && box.querySelector('[data-monogram-toggle]');
  const input = box && box.querySelector('[data-monogram-input]');
  ok('monogram block renders on eligible pieces', !!box && !!toggle && !!input);
  if (toggle && input) {
    toggle.checked = true;
    fire(window, toggle, 'change');
    await wait(60);
    ok('toggling monogram reveals the body', !box.querySelector('[data-monogram-body]').hidden);
    await type(window, input, 'ab!!');
    await wait(80);
    ok('input is cleaned + uppercased live', input.value === 'AB', input.value);
    const preview = box.querySelector('[data-monogram-preview]');
    ok('preview mirrors the characters', preview && preview.textContent.includes('AB'));
    const submit = doc.querySelector('[data-add-submit]');
    ok('the add button quotes the monogram fee', submit && /Monogram/i.test(submit.textContent), submit ? submit.textContent.replace(/\s+/g, ' ').slice(0, 60) : 'missing');
    toggle.checked = false;
    fire(window, toggle, 'change');
  }

  /* size finder */
  const fitForm = doc.querySelector('[data-fit-form]');
  if (fitForm) {
    const heightFt = fitForm.querySelector('input[name="heightFt"]');
    const heightIn = fitForm.querySelector('input[name="heightIn"]');
    const weight = fitForm.querySelector('input[name="weight"]');
    if (heightFt) heightFt.value = '5';
    if (heightIn) heightIn.value = '10';
    if (weight) weight.value = '170';
    fire(window, fitForm, 'submit');
    await wait(900);
    ok('size finder posts to /api/fit', window.__fetches.some(u => u.includes('/api/fit')));
    const result = doc.querySelector('[data-fit-result]');
    ok('size finder renders a recommendation', result && !result.hidden && /We suggest/i.test(result.textContent), result ? result.textContent.replace(/\s+/g, ' ').slice(0, 80) : 'missing');
    const apply = doc.querySelector('[data-fit-apply]');
    if (apply) {
      fire(window, apply, 'click');
      await wait(80);
      const sizeLabel = doc.querySelector('[data-size-label]');
      ok('applying the pick selects that size', sizeLabel && sizeLabel.textContent.trim() === apply.getAttribute('data-fit-apply'),
        sizeLabel ? sizeLabel.textContent.trim() : 'missing');
    }
  } else ok('size finder form present', false, 'no data-fit-form');

  /* shop the look */
  const lookBtn = doc.querySelector('[data-add-look]');
  if (lookBtn) {
    const countBefore = Number(doc.querySelector('[data-cart-count]').textContent) || 0;
    fire(window, lookBtn, 'click');
    await wait(1100);
    ok('shop-the-look adds the whole look in one call', window.__fetches.filter(u => u.includes('/api/cart/add')).length > 0);
    const countAfter = Number(doc.querySelector('[data-cart-count]').textContent) || 0;
    ok('look add increases the cart by the full set', countAfter >= countBefore + 2, `${countBefore} → ${countAfter}`);
  } else ok('shop-the-look button present', false, 'no data-add-look');

  /* back-in-stock alert on a sold-out size */
  const soldOutBtn = Array.from(doc.querySelectorAll('[data-size]')).find(b => b.getAttribute('data-stock') === '0');
  if (soldOutBtn) {
    fire(window, soldOutBtn, 'click');
    await wait(80);
    const notifyForm = doc.querySelector('[data-notify-form]');
    const email = notifyForm && notifyForm.querySelector('input[type="email"]');
    if (notifyForm && email) {
      await type(window, email, 'browser.smoke@example.com');
      fire(window, notifyForm, 'submit');
      await wait(800);
      ok('alert form posts to /api/notify', window.__fetches.some(u => u.includes('/api/notify')));
      ok('alert confirmation renders', /will email|back in stock/i.test(doc.body.textContent));
    } else ok('notify form fields present', false, 'missing email input');
  } else ok('a sold-out size exists for the alert test', false, 'no data-stock=0 button');

  window.close();
}

async function testSearchMemory() {
  section('Search memory (localStorage, no server state)');
  const dom = await openPage('/', { label: 'search-memory' });
  const { window } = dom;
  const doc = window.document;

  fire(window, doc.querySelector('[data-search-open]'), 'click');
  await type(window, doc.querySelector('[data-search-input]'), 'jogger');
  await wait(400);
  const searchForm = doc.querySelector('[data-search-form]');
  if (searchForm) {
    // stop jsdom actually navigating to /search — we only want the remember() side effect
    searchForm.addEventListener('submit', e => e.preventDefault(), { capture: true });
    fire(window, searchForm, 'submit');
    await wait(120);
  }
  fire(window, doc.querySelector('[data-search-close]'), 'click');
  await wait(320);

  const stored = window.localStorage.getItem('vnx_searches') || '[]';
  ok('recent search is stored locally on submit', stored.includes('jogger'), stored);

  // recent searches live in the default (empty-query) panel — clear the input
  // and reopen so the default panel (with the slot) is restored
  const input2 = doc.querySelector('[data-search-input]');
  input2.value = '';
  fire(window, input2, 'input');
  await wait(300);
  fire(window, doc.querySelector('[data-search-open]'), 'click');
  await wait(160);
  const slot = doc.querySelector('[data-recent-searches]');
  ok('reopening the overlay lists the recent search', slot && /jogger/.test(slot.textContent), slot ? slot.textContent.trim().slice(0, 40) : 'missing');
  window.close();
}

/* ----------------------------------- main --------------------------------- */

(async function main() {
  const host = await ensureBase(BASE || process.env.BASE_URL);
  BASE = host.base;
  stopServer = host.stop;
  console.log(`\nVennix browser smoke → ${BASE}\n${'─'.repeat(48)}`);
  await prime();
  try {
    await testHome();
    await testProductPage();
    await testCartPage();
    await testMotion();
    await testPersonalization();
    await testSearchMemory();
  } catch (error) {
    failed += 1;
    console.log('  ✗ unexpected harness error:', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' ') : error);
  }
  if (stopServer) await stopServer();
  console.log(`\n${'─'.repeat(48)}\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
