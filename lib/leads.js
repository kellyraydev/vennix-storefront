'use strict';
/**
 * leads.js — tiny local store for NON-COMMERCE captures only:
 * newsletter signups, contact messages, back-in-stock alert requests and
 * pending review submissions.
 *
 * This is deliberately NOT a product/inventory/order database — none of it
 * can contradict Shopify, which remains the single source of truth for
 * commerce. Swap points for real tooling (Klaviyo, Judge.me, …) are
 * documented in the README.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LEADS_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'leads.json');

const TABLES = ['subscribers', 'messages', 'backInStock', 'reviews', 'activity'];

let db = null;
let writeScheduled = false;

/**
 * Durability is a *reportable* property, not an assumption.
 *
 * A serverless deployment (Vercel, and any read-only deployment filesystem)
 * accepts a lead, answers the shopper with "thank you", and then silently
 * drops it on the floor when the write fails — which is the worst possible
 * failure mode for a marketing capture. So the failure is counted, surfaced on
 * `/healthz`, refused by `npm run doctor`, and warned about once at boot with
 * the actual remedy.
 */
const durability = {
  writable: true,
  writeFailures: 0,
  lastError: null,
  lastWriteAt: null,
  warnedAt: 0
};

function warnUnwritable(reason) {
  durability.writable = false;
  durability.lastError = String(reason || 'write failed');
  const now = Date.now();
  if (now - durability.warnedAt < 60_000) return; // one warning per minute, not per request
  durability.warnedAt = now;
  console.warn(`[leads] ${DB_FILE} is not writable — captures are accepted but NOT persisted.`);
  console.warn('[leads] fix: point LEADS_DIR at writable, persistent storage, or wire lib/leads.js to your own sink (Klaviyo, a webhook, a queue).');
}

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    return true;
  } catch (err) {
    warnUnwritable(err.code || err.message);
    return false;
  }
}

function emptyDb() {
  const d = { meta: { version: 1, createdAt: new Date().toISOString() }, sequences: {} };
  for (const t of TABLES) d[t] = [];
  return d;
}

function load() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      for (const t of TABLES) if (!Array.isArray(db[t])) db[t] = [];
    } catch (err) {
      const backup = DB_FILE.replace('.json', `.corrupt-${Date.now()}.json`);
      fs.renameSync(DB_FILE, backup);
      console.error(`[leads] leads.json unreadable (${err.message}); moved to ${path.basename(backup)} and starting fresh.`);
      db = emptyDb();
    }
  } else {
    db = emptyDb();
  }
  return db;
}

function getDb() { return db || load(); }

function saveNow() {
  writeScheduled = false;
  if (!ensureDir()) { durability.writeFailures += 1; return false; }
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    durability.writeFailures += 1;
    warnUnwritable(err.code || err.message);
    return false;
  }
  durability.writable = true;
  durability.lastError = null;
  durability.lastWriteAt = new Date().toISOString();
  return true;
}

/**
 * Debounced write. Never throws: a lead that cannot be persisted must not turn
 * into a 500 for the shopper, but it must not stay quiet either — hence the
 * counters on `stats()`.
 */
function save() {
  if (writeScheduled) return;
  writeScheduled = true;
  setTimeout(() => { try { saveNow(); } catch (e) { durability.writeFailures += 1; warnUnwritable(e && (e.code || e.message)); } }, 120);
}

function nextId(table) {
  const d = getDb();
  d.sequences[table] = (d.sequences[table] || 0) + 1;
  save();
  const prefix = { subscribers: 'sub', messages: 'msg', backInStock: 'ntf', reviews: 'rev', activity: 'act' }[table] || table.slice(0, 3);
  return `${prefix}_${d.sequences[table].toString().padStart(6, '0')}`;
}

function uid(prefix = 'id') { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }

function all(table) { return getDb()[table] || []; }
function find(table, predicate) { return all(table).find(predicate); }

function insert(table, row) {
  const d = getDb();
  if (!d[table]) d[table] = [];
  const record = { id: row.id || nextId(table), createdAt: row.createdAt || new Date().toISOString(), ...row };
  d[table].push(record);
  save();
  return record;
}

function update(table, id, patch) {
  const row = getDb()[table].find(r => r.id === id);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  save();
  return row;
}

function logActivity(actor, action, detail) {
  return insert('activity', { actor, action, detail, at: new Date().toISOString() });
}

/**
 * Probe the sink without writing to it: used at boot (to warn early) and by
 * `npm run doctor` (to refuse a deploy that would drop captures).
 */
function checkWritable() {
  const target = fs.existsSync(DATA_DIR) ? DATA_DIR : path.dirname(DATA_DIR);
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return { writable: true, file: DB_FILE, reason: null };
  } catch (err) {
    return { writable: false, file: DB_FILE, reason: err.code || err.message };
  }
}

/** Everything an operator needs to know about where the leads actually go. */
function stats() {
  return {
    file: DB_FILE,
    writable: durability.writable,
    writeFailures: durability.writeFailures,
    lastError: durability.lastError,
    lastWriteAt: durability.lastWriteAt,
    pendingWrite: writeScheduled
  };
}

module.exports = {
  DB_FILE, DATA_DIR, TABLES, getDb, save, saveNow, all, find, insert, update,
  nextId, uid, logActivity, stats, checkWritable
};
