# QNIFT Equity signal server (Angel One + Telegram)

An always-on server that scans **NSE equity (cash) stocks** for high-quality
**momentum-breakout** setups and fires **entry / target / stop-loss** alerts to
Telegram — even with your app closed. It's a standalone sibling of
[`qnift_server`](https://github.com/kingkish269-ship-it/qnift_server) and does
**not** touch that repo.

Data comes from the **free Angel One SmartAPI**. The server logs in **completely
unattended** — see the TOTP note below.

---

## ⚠️ Read this first (honest disclaimer)

- These are **screened candidates, not guaranteed trades.** Every alert carries a
  **stop-loss** precisely because a good share of setups will *not* work out.
- There is **no such thing as a guaranteed "minimum X%" return.** This server
  makes no such promise, and neither should anyone else.
- A realistic momentum strategy wins roughly **40–55%** of the time and profits
  through **risk management** (stops + position sizing), not prediction.
- This is educational tooling, **not investment advice.** Trade your own money at
  your own risk; consider paper-trading first.

---

## The Google Authenticator question (why it's NOT a problem on a server)

You **never type a 6-digit Google Authenticator code** into this server. Those
codes are generated from a one-time **base32 secret**. You store *that secret*
once as `ANGEL_TOTP_SECRET`, and the server generates the current code itself on
every login (via `otplib`). So it runs 24×7 with no manual login.

---

## What keeps junk out (the "Varanium Cloud" problem)

1. **Index-membership gate (primary):** only constituents of a broad,
   index-committee-vetted index (default **Nifty 100**) are considered.
   SME / penny / pump-and-dump shells are not members, so they never appear.
2. **EQ-series only:** drops ETFs, bonds and illiquid series.
3. **Liquidity & price gates:** min price, min average volume, min average daily
   turnover (₹ cr) — all tunable via env.

## The strategy logic

Long-only momentum breakout (`src/signals.ts`):

| Component | Rule (default) |
|-----------|----------------|
| Trend     | close > EMA20 > EMA50 (and > EMA200 when available) |
| Trigger   | close breaks / is within 1% of the 20-day high |
| Volume    | today's volume ≥ 1.5× the 20-day average |
| Momentum  | RSI(14) between 55 and 78 |

Trade construction is **ATR-based**: stop = entry − 1.5×ATR, target = entry +
3.0×ATR (reward:risk ≈ 2:1). A setup is emitted only if R:R ≥ 1.8 and the stop
is ≤ 6%.

---

## Setup

### 1) Angel One SmartAPI credentials (all FREE)
1. Open a free Angel One account.
2. Register a **Trading API** app at <https://smartapi.angelone.in/> → get the **API key**.
3. Enable TOTP at <https://smartapi.angelone.in/enable-totp>, scan the QR in an
   authenticator app, and copy the long **BASE32 secret** behind the QR (the
   long string, **not** the 6-digit code) → this is `ANGEL_TOTP_SECRET`.
4. You'll also need your **client code** and login **MPIN**.

### 2) Telegram bot + chat id
1. In Telegram open **@BotFather** → `/newbot` → get the **bot token** (`TELEGRAM_BOT_TOKEN`).
2. Send your new bot any message so it may message you.
3. Open **@userinfobot** → `/start` → it replies with your numeric **id** (`TELEGRAM_CHAT_ID`).

### 3) Deploy on Render (free)
1. Push this repo to GitHub (`kingkish269-ship-it/qnift_server_equity`).
2. On Render: **New → Blueprint**, pick this repo (it reads `render.yaml`).
3. In the service **Environment** tab, fill in the six required vars:
   `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_MPIN`, `ANGEL_TOTP_SECRET`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
4. Deploy → you get a URL like `https://qnift-equity-signal-server.onrender.com`.

### 4) Verify
- `GET /health` → shows `hasCreds:true`, `telegram:true`, universe size.
- `GET /test-telegram` → you should get a Telegram message instantly.
- `GET /scan` → runs a scan now and returns candidates as JSON (no alerts).
- `GET /scan?alert=1` → runs a scan and sends the alerts to Telegram.

### 5) Keep it awake (Render free sleeps after 15 min idle)
Create a free **UptimeRobot** monitor (<https://uptimerobot.com>) hitting
`https://YOUR-URL/health` every **5 minutes**.

---

## Run locally
```bash
npm install
ANGEL_API_KEY=... ANGEL_CLIENT_CODE=... ANGEL_MPIN=... ANGEL_TOTP_SECRET=... \
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npm start
# then:
curl http://localhost:3000/health
curl "http://localhost:3000/scan"          # run a scan, JSON only
```
Type-check without running: `npm run typecheck`.

---

## Scan cadence

| `SCAN_MODE` | When it scans | Best for |
|-------------|---------------|----------|
| `eod` (default) | once daily at `EOD_SCAN_HHMM` IST (default 15:20) on daily candles | short-term / swing (next-day plans) |
| `intraday` | every `SCAN_EVERY_MIN` min during market hours (set `SCAN_INTERVAL=FIFTEEN_MINUTE`) | intraday momentum |

The Angel One historical-candle endpoint is rate-limited (~3 req/sec); the
scanner paces requests (`API_SLEEP_MS`). A ~100-stock EOD scan takes ~40–60s.

## Environment variables

| Var | Required | Notes |
|-----|----------|-------|
| `ANGEL_API_KEY` | yes | SmartAPI app key |
| `ANGEL_CLIENT_CODE` | yes | e.g. A123456 |
| `ANGEL_MPIN` | yes | login PIN |
| `ANGEL_TOTP_SECRET` | yes | BASE32 secret (not the 6-digit code) |
| `TELEGRAM_BOT_TOKEN` | yes | from @BotFather |
| `TELEGRAM_CHAT_ID` | yes | from @userinfobot |
| `INDEX_UNIVERSE` | no | NIFTY50/100/200/500 (default NIFTY100) |
| `SCAN_MODE` | no | eod (default) / intraday |
| `SCAN_INTERVAL` | no | ONE_DAY (default) / FIFTEEN_MINUTE / … |
| `SCAN_EVERY_MIN` | no | intraday cadence (default 15) |
| `EOD_SCAN_HHMM` | no | daily scan time IST (default 1520) |
| `MAX_ALERTS_PER_SCAN` | no | cap messages per scan (default 5) |
| `MIN_PRICE` / `MAX_PRICE` / `MIN_AVG_VOLUME` / `MIN_AVG_TURNOVER_CR` | no | liquidity gates |
| `PORT` | no | default 3000 |

## Endpoints

- `GET /health` — status (creds/telegram wired, universe, last scan, last error).
- `GET /test-telegram` — send a test message.
- `GET /signal` — last scan's candidates (JSON, no alert).
- `GET /scan` — run a scan now (JSON). Add `?alert=1` to also send Telegram alerts.

## Alert format

```
🔔 SOMESTOCK  (score 2.14)
📈 Entry ≈ ₹1250.4
🎯 Target ₹1310.2  (+4.78%)
🛑 Stop-loss ₹1220.3  (−2.41%)
⚖️ R:R 1:2  ·  RSI 66.2  ·  Vol 2.31×
momentum-breakout (long) · 2026-09-07
```

De-duped per symbol per day, capped at `MAX_ALERTS_PER_SCAN` per scan.

---

## Project layout
```
qnift_server_equity/
├── index.ts              # server + scheduling + Telegram + endpoints
├── src/
│   ├── angel.ts          # Angel One SmartAPI client (server-side TOTP login)
│   ├── universe.ts       # universe build + anti-junk quality gates
│   ├── indicators.ts     # EMA / RSI / ATR / breakout / volume
│   ├── signals.ts        # signal logic -> entry / target / stop
│   └── ist.ts            # IST + market-hours helpers
├── render.yaml
├── package.json
├── tsconfig.json
└── .env.example
```

## Notes
- Render's free filesystem is ephemeral, so the per-day dedupe cache resets on
  restart — worst case you get a duplicate alert after a redeploy. Harmless.
- The universe is loaded once at boot and cached in memory.
