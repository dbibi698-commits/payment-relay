// Payment Relay — tiny FREE public relay for a small print shop.
// Closes the payment-detection loop:
//   Android SMS Observer (bank phone)  --POST /api/report-->  this relay
//   Payment Gateway                    --GET /api/pending-reports--> this relay
// Zero dependencies: plain Node http + built-in node:sqlite. No build step.
//
// Env vars:
//   PORT        listen port (default 3000)
//   RELAY_KEY   shared secret; when set, POST /api/report, GET /api/pending-reports
//               and POST /api/claim require header  x-relay-key: <RELAY_KEY>
//   SHOP_CODE   shop code shown on the status page (default SHOP-49J4-T352)
//   SHOP_UPI    shop UPI ID shown on the status page (default 8327352996@fam)
//   DB_PATH     SQLite file (default ./data/relay.db)
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = parseInt(process.env.PORT || '3000', 10);
const RELAY_KEY = (process.env.RELAY_KEY || '').trim();
const SHOP_CODE = process.env.SHOP_CODE || 'SHOP-49J4-T352';
const SHOP_UPI = process.env.SHOP_UPI || '8327352996@fam';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'relay.db');

if (!RELAY_KEY) {
  console.warn('[relay] WARNING: RELAY_KEY is not set — the API is unauthenticated. Set RELAY_KEY in production.');
}

// --- database ---------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_paise INTEGER NOT NULL,
    utr TEXT,
    sms_text TEXT,
    source TEXT,
    shop_code TEXT,
    licence_key TEXT,
    claimed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- One row per UTR: a second report with the same UTR is a duplicate, not a new payment.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_utr ON reports(utr) WHERE utr IS NOT NULL AND utr <> '';
  CREATE INDEX IF NOT EXISTS idx_reports_claimed ON reports(claimed, id);
`);

const insertReport = db.prepare(
  'INSERT INTO reports (amount_paise, utr, sms_text, source, shop_code, licence_key) VALUES (?, ?, ?, ?, ?, ?)'
);
const findByUtr = db.prepare('SELECT id, amount_paise, utr, claimed FROM reports WHERE utr = ?');
const findById = db.prepare('SELECT id, amount_paise, utr, claimed FROM reports WHERE id = ?');
const listUnclaimed = db.prepare(
  'SELECT id, amount_paise, utr, sms_text, source, shop_code, created_at FROM reports WHERE claimed = 0 AND (? IS NULL OR id > ?) ORDER BY id DESC LIMIT 100'
);
const claimReport = db.prepare('UPDATE reports SET claimed = 1 WHERE id = ? AND claimed = 0');
const countAll = db.prepare('SELECT COUNT(*) AS n FROM reports');
const countUnclaimed = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE claimed = 0');

// --- validation -------------------------------------------------------------
const DEBIT_WORDS = /\b(debited|debit|withdrawn|deducted|spent)\b/i;

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function requireKey(req, res) {
  if (!RELAY_KEY) return true;
  if (req.headers['x-relay-key'] === RELAY_KEY) return true;
  sendJson(res, 401, { ok: false, error: 'missing or wrong x-relay-key header' });
  return false;
}

// --- handlers ---------------------------------------------------------------
async function handleReport(req, res) {
  if (!requireKey(req, res)) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }

  const amountPaise = body.amount_paise;
  const utr = body.utr === undefined || body.utr === null ? null : String(body.utr).trim();
  const smsText = body.sms_text === undefined || body.sms_text === null ? null : String(body.sms_text);
  const source = body.source ? String(body.source).slice(0, 64) : null;
  const shopCode = body.shop_code ? String(body.shop_code).slice(0, 64) : null;
  const licenceKey = body.licence_key ? String(body.licence_key).slice(0, 64) : null;

  if (!isPositiveInt(amountPaise)) {
    return sendJson(res, 400, { ok: false, error: 'amount_paise must be a positive integer (paise)' });
  }
  if (utr !== null && utr !== '' && !/^\d{12}$/.test(utr)) {
    return sendJson(res, 400, { ok: false, error: 'utr must be 12 digits when present' });
  }
  if (smsText && DEBIT_WORDS.test(smsText)) {
    return sendJson(res, 400, { ok: false, error: 'debit SMS rejected: only bank credit SMS are accepted' });
  }

  const cleanUtr = utr === '' ? null : utr;
  if (cleanUtr) {
    const existing = findByUtr.get(cleanUtr);
    if (existing) {
      // Same UTR twice = one row. Do not create a second payment.
      return sendJson(res, 200, { ok: true, id: existing.id, matched: false, deduped: true });
    }
  }

  const info = insertReport.run(amountPaise, cleanUtr, smsText, source, shopCode, licenceKey);
  return sendJson(res, 200, { ok: true, id: Number(info.lastInsertRowid), matched: false, deduped: false });
}

function handlePending(req, res, url) {
  if (!requireKey(req, res)) return;
  const sinceRaw = url.searchParams.get('since');
  let since = null;
  if (sinceRaw !== null && sinceRaw !== '') {
    since = parseInt(sinceRaw, 10);
    if (!Number.isInteger(since) || since < 0) {
      return sendJson(res, 400, { ok: false, error: 'since must be a non-negative integer report id' });
    }
  }
  const rows = listUnclaimed.all(since, since);
  return sendJson(res, 200, { ok: true, reports: rows });
}

async function handleClaim(req, res) {
  if (!requireKey(req, res)) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: e.message });
  }
  const reportId = body.report_id;
  if (!isPositiveInt(reportId)) {
    return sendJson(res, 400, { ok: false, error: 'report_id must be a positive integer' });
  }
  const info = claimReport.run(reportId);
  if (info.changes === 0) {
    const row = findById.get(reportId);
    if (!row) return sendJson(res, 404, { ok: false, error: 'report not found' });
    return sendJson(res, 409, { ok: false, error: 'report already claimed' });
  }
  return sendJson(res, 200, { ok: true, claimed: true, report_id: reportId });
}

function handleStatusPage(res) {
  const total = countAll.get().n;
  const unclaimed = countUnclaimed.get().n;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Relay — ${SHOP_CODE}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
h1{font-size:22px}.card{border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0}
.big{font-size:28px;font-weight:700}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Payment Relay</h1>
<p>Shop: <b>${SHOP_CODE}</b> &nbsp;·&nbsp; UPI: <b>${SHOP_UPI}</b></p>
<div class="card"><div class="big">${unclaimed}</div>unclaimed payment reports</div>
<div class="card"><div class="big">${total}</div>total reports stored</div>
<p>Endpoints: <code>POST /api/report</code> · <code>GET /api/pending-reports</code> · <code>POST /api/claim</code> · <code>GET /health</code></p>
<p><small>Free relay: the Android SMS Observer posts bank-credit detections here; the payment gateway polls for them and marks sessions paid. No bank details or secrets are stored here.</small></p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

// --- server -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return handleStatusPage(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/report') {
      return handleReport(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/pending-reports') {
      return handlePending(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/api/claim') {
      return handleClaim(req, res);
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[relay] error:', e);
    return sendJson(res, 500, { ok: false, error: 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] listening on :${PORT} (shop ${SHOP_CODE}, UPI ${SHOP_UPI})`);
});
