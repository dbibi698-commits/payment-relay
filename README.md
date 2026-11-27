# Payment Relay

A tiny **free** public relay that closes the payment-detection loop for a small
print shop. Zero dependencies — plain Node.js `http` + built-in `node:sqlite`.
No build step.

```
Android SMS Observer (bank phone)  -- POST /api/report -->  this relay
Payment Gateway                    -- GET /api/pending-reports --> this relay
```

The shop's Payment Gateway has no public URL, so the phone app cannot report
detections to it directly. This relay is the public mailbox in the middle:
the phone drops a credit report here, the gateway polls for unclaimed reports
and marks sessions paid, then claims each report so it is never delivered twice.

Shop: **Murshid Sk** · UPI: **8327352996@fam** · Shop code: **SHOP-49J4-T352**

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `GET` | `/health` | none | `{ok:true}` |
| `GET` | `/` | none | Status page: report counts + shop UPI |
| `POST` | `/api/report` | `x-relay-key` | Store an incoming-credit report |
| `GET` | `/api/pending-reports` | `x-relay-key` | Unclaimed reports, newest first. `?since=<id>` returns only `id > since`. |
| `POST` | `/api/claim` | `x-relay-key` | Mark a report claimed so it is not delivered twice |

Auth: when `RELAY_KEY` is set, the three `/api/*` endpoints require the header
`x-relay-key: <RELAY_KEY>`. When it is unset (local dev only) the API is open.

### POST /api/report

Request JSON:

```json
{
  "amount_paise": 100,
  "utr": "123456789012",
  "sms_text": "Rs.1.00 credited to your FamPay account. UPI Ref No 123456789012",
  "source": "sms_observer",
  "shop_code": "SHOP-49J4-T352",
  "licence_key": "SQP-XXXX-XXXX-XXXX"
}
```

Rules:

- `amount_paise` must be a positive integer (paise: ₹1 = 100).
- `utr` is optional, but when present must be exactly 12 digits.
- `sms_text` containing debit wording (`debited`, `debit`, `withdrawn`,
  `deducted`, `spent`) is rejected with 400 — only bank **credit** SMS are accepted.
- **De-duplicated by UTR:** posting the same UTR twice stores one row and
  returns the original id with `"deduped": true`.

Success response: `{ok:true, id:1, matched:false, deduped:false}`.

### GET /api/pending-reports

Response:

```json
{
  "ok": true,
  "reports": [
    {
      "id": 1,
      "amount_paise": 100,
      "utr": "123456789012",
      "sms_text": "Rs.1.00 credited to your FamPay account. UPI Ref No 123456789012",
      "source": "sms_observer",
      "shop_code": "SHOP-49J4-T352",
      "created_at": "2026-11-27 08:00:00"
    }
  ]
}
```

The `licence_key` is stored but **never** returned by any GET endpoint.

### POST /api/claim

Request: `{"report_id": 1}` → response `{ok:true, claimed:true, report_id:1}`.
Claiming an already-claimed report returns 409; an unknown id returns 404.

## Run locally

```bash
npm install   # zero dependencies, just creates package-lock
RELAY_KEY=test-relay-key npm start   # listens on :3000
```

Requires Node **22.5+** (`node:sqlite` needs `--experimental-sqlite` on Node 22;
the start script already passes that flag, and it is harmless on Node 24).

## Test with curl (₹1 test credit)

```bash
# 1. Report a ₹1 credit (amount_paise is paise: 100 = ₹1)
curl -s -X POST http://localhost:3000/api/report \
  -H 'Content-Type: application/json' \
  -H 'x-relay-key: test-relay-key' \
  -d '{"amount_paise":100,"utr":"123456789012","sms_text":"Rs.1.00 credited to your FamPay account. UPI Ref No 123456789012","source":"sms_observer","shop_code":"SHOP-49J4-T352"}'

# 2. Same UTR again -> deduped, same id, no second row
curl -s -X POST http://localhost:3000/api/report \
  -H 'Content-Type: application/json' \
  -H 'x-relay-key: test-relay-key' \
  -d '{"amount_paise":100,"utr":"123456789012","sms_text":"Rs.1.00 credited to your FamPay account. UPI Ref No 123456789012","source":"sms_observer","shop_code":"SHOP-49J4-T352"}'

# 3. Poll pending reports
curl -s 'http://localhost:3000/api/pending-reports' -H 'x-relay-key: test-relay-key'

# 4. Claim it (gateway does this after marking the session paid)
curl -s -X POST http://localhost:3000/api/claim \
  -H 'Content-Type: application/json' \
  -H 'x-relay-key: test-relay-key' \
  -d '{"report_id":1}'

# 5. Pending list is now empty; a debit SMS is rejected (400)
curl -s -X POST http://localhost:3000/api/report \
  -H 'Content-Type: application/json' \
  -H 'x-relay-key: test-relay-key' \
  -d '{"amount_paise":100,"utr":"123456789013","sms_text":"Rs.100 debited from your account","source":"sms_observer"}'
```

## Deploy free on Render (no card)

`render.yaml` is included — it creates a **free** Node web service.

1. Push this repo to GitHub (public).
2. In [Render Dashboard](https://dashboard.render.com) → **New → Web Service** →
   **Build and deploy from a Git repository** → pick this repo.
3. Render reads `render.yaml`: plan **Free**, build `npm install`,
   start `node --experimental-sqlite server.js`. `RELAY_KEY` is auto-generated
   (Render → Environment → copy its value).
4. Copy the service URL, e.g. `https://payment-relay-xxxx.onrender.com`.
   That URL is the `SERVER_URL` for the SMS Observer app and the poll URL for
   the gateway. Set the same `RELAY_KEY` value in both.
5. Free-plan note: the service sleeps after inactivity and wakes on the next
   request (first poll after sleep takes ~30–60s). Disk is ephemeral, so the
   SQLite file is a delivery queue, not a permanent ledger — the gateway must
   claim reports promptly, and the shop should reconcile against bank SMS.

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | Render sets this itself |
| `RELAY_KEY` | yes in prod | (none) | Shared secret for the `/api/*` endpoints |
| `SHOP_CODE` | no | `SHOP-49J4-T352` | Shown on the status page |
| `SHOP_UPI` | no | `8327352996@fam` | Shown on the status page |
| `DB_PATH` | no | `data/relay.db` | SQLite file |

## What the gateway must do

Poll `GET /api/pending-reports?since=<last_seen_id>` with the `x-relay-key`
header (every few seconds while a checkout is waiting, or every minute).
For each report: find the oldest pending session with the same
`amount_paise` (within a 30-minute window, and check the UTR has not been
used before), mark it paid, then `POST /api/claim {"report_id": <id>}`.
Never mark a session paid from a report that was already claimed.

## Security notes

- No secrets are committed in this repo. `RELAY_KEY` lives only in the
  Render environment (auto-generated by `render.yaml`).
- The `licence_key` field is accepted so the phone can prove which shop it
  is, but it is never returned by any GET endpoint.
- This is a notification relay, not a bank API: it trusts the phone that
  holds the `RELAY_KEY`. Keep the key private, reconcile against bank SMS,
  and do not use it to collect payments for other merchants.
