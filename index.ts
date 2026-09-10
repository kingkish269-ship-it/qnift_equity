// QNIFT EQUITY signal server (Angel One + Telegram)
// ---------------------------------------------------------------------------
// A standalone always-on server that scans NSE equities for high-quality
// momentum-breakout setups and fires entry / target / stop-loss alerts to
// Telegram. Sibling of qnift_server — it does NOT touch that repo.
//
// Auth is unattended: we store the Angel One TOTP *secret* and generate the
// 6-digit code server-side via otplib. You never enter a Google Authenticator
// code. See README.
//
// ⚠️ These are SCREENED CANDIDATES, not guaranteed trades. Every alert carries a
// stop-loss precisely because a good share of setups will not work out.

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AngelClient, sleep } from "./src/angel.js";
import {
  fmtIstClock,
  istDateStr,
  istMinutes,
  isWeekday,
  marketOpenIST,
} from "./src/ist.js";
import {
  DEFAULT_SIGNAL_CONFIG,
  evaluate,
  type Signal,
  type SignalConfig,
} from "./src/signals.js";
import {
  loadUniverse,
  passesLiquidity,
  type Instrument,
  type QualityConfig,
} from "./src/universe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config (env with sensible defaults) ----
const PORT = Number(process.env.PORT) || 3000;
const INDEX_UNIVERSE = (process.env.INDEX_UNIVERSE || "NIFTY100").toUpperCase();
const SCAN_MODE = (process.env.SCAN_MODE || "eod").toLowerCase(); // "eod" | "intraday"
const SCAN_INTERVAL = process.env.SCAN_INTERVAL || "ONE_DAY";
const SCAN_EVERY_MIN = Number(process.env.SCAN_EVERY_MIN) || 15;
const EOD_SCAN_HHMM = process.env.EOD_SCAN_HHMM || "1520"; // IST HHMM for daily scan
const MAX_ALERTS_PER_SCAN = Number(process.env.MAX_ALERTS_PER_SCAN) || 5;
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || (SCAN_INTERVAL === "ONE_DAY" ? 400 : 30);
const API_SLEEP_MS = Number(process.env.API_SLEEP_MS) || 350;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const QUALITY: QualityConfig = {
  minPrice: Number(process.env.MIN_PRICE) || 50,
  maxPrice: Number(process.env.MAX_PRICE) || 20000,
  minAvgVolume: Number(process.env.MIN_AVG_VOLUME) || 200_000,
  minAvgTurnoverCr: Number(process.env.MIN_AVG_TURNOVER_CR) || 10,
  liquidityLookback: DEFAULT_SIGNAL_CONFIG.liquidityLookback,
};
// Signal-screen knobs, env-tunable (defaults are the "somewhat looser" values in
// signals.ts). Raise VOL_SPIKE_MULT / narrow RSI to tighten; lower to loosen.
const numEnv = (v: string | undefined, d: number) => (v != null && Number(v) > 0 ? Number(v) : d);
const SIGNAL_CFG: SignalConfig = {
  ...DEFAULT_SIGNAL_CONFIG,
  volSpikeMult: numEnv(process.env.VOL_SPIKE_MULT, DEFAULT_SIGNAL_CONFIG.volSpikeMult),
  rsiMin: numEnv(process.env.RSI_MIN, DEFAULT_SIGNAL_CONFIG.rsiMin),
  rsiMax: numEnv(process.env.RSI_MAX, DEFAULT_SIGNAL_CONFIG.rsiMax),
  breakoutTolerance: numEnv(process.env.BREAKOUT_TOL, DEFAULT_SIGNAL_CONFIG.breakoutTolerance),
  maxStopPct: numEnv(process.env.MAX_STOP_PCT, DEFAULT_SIGNAL_CONFIG.maxStopPct),
};

const angel = new AngelClient({
  apiKey: process.env.ANGEL_API_KEY || "",
  clientCode: process.env.ANGEL_CLIENT_CODE || "",
  mpin: process.env.ANGEL_MPIN || "",
  totpSecret: process.env.ANGEL_TOTP_SECRET || "",
});

// ---- tiny JSON persistence for dedupe (no DB) ----
const STATE_FILE = path.join(__dirname, "state_equity.json");
interface State {
  // symbol -> last alert date (YYYY-MM-DD) so we don't re-alert the same name same day
  alertedOn: Record<string, string>;
  lastEodScanDate?: string;
}
function loadState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { alertedOn: {} };
  }
}
function saveState(s: State): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {
    /* ignore (Render FS is ephemeral; dedupe is best-effort) */
  }
}

// ---- runtime status (for /health) ----
let universe: Instrument[] = [];
let lastScanAt: number | null = null;
let lastScanCount = 0;
let lastError: string | null = null;
let lastSignals: Signal[] = [];
let scanning = false;

// ---- Telegram ----
async function sendTelegram(text: string): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    const j: any = await res.json().catch(() => null);
    if (!j?.ok) console.error("telegram send failed:", j?.description || res.status);
    return !!j?.ok;
  } catch (e) {
    console.error("telegram error:", (e as Error).message);
    return false;
  }
}

function messageFor(s: Signal): string {
  return (
    `🔔 <b>${s.symbol}</b>  (score ${s.score})\n` +
    `📈 Entry ≈ ₹${s.entry}\n` +
    `🎯 Target ₹${s.target}  (+${s.targetPct}%)\n` +
    `🛑 Stop-loss ₹${s.stopLoss}  (−${s.stopPct}%)\n` +
    `⚖️ R:R 1:${s.riskReward}  ·  RSI ${s.rsi}  ·  Vol ${s.volMultiple}×\n` +
    `<i>${s.note} · ${s.date}</i>`
  );
}

// ---- ensure the universe is loaded (lazy, cached) ----
async function ensureUniverse(): Promise<Instrument[]> {
  if (universe.length > 0) return universe;
  universe = await loadUniverse(INDEX_UNIVERSE);
  return universe;
}

// ---- one full scan pass ----
async function runScan(alert: boolean): Promise<Signal[]> {
  if (scanning) return lastSignals;
  scanning = true;
  lastError = null;
  const found: Signal[] = [];
  try {
    if (!angel.hasCreds()) {
      lastError = "Angel One credentials not set";
      return [];
    }
    const insts = await ensureUniverse();
    let evaluated = 0;
    let skippedLiq = 0;
    for (const inst of insts) {
      try {
        const candles = await angel.getCandles(inst.token, SCAN_INTERVAL, HISTORY_DAYS);
        const liq = passesLiquidity(candles, QUALITY);
        if (!liq.ok) {
          skippedLiq++;
          continue;
        }
        evaluated++;
        const sig = evaluate(inst.symbol, candles, SIGNAL_CFG);
        if (sig) found.push(sig);
      } catch (e) {
        lastError = (e as Error).message;
      }
      await sleep(API_SLEEP_MS); // pace to respect ~3 req/sec historical limit
    }

    found.sort((a, b) => b.score - a.score);
    lastSignals = found;
    lastScanAt = Date.now();
    lastScanCount = evaluated;
    console.log(
      `[scan] ${evaluated} evaluated, ${skippedLiq} filtered on liquidity, ` +
        `${found.length} trade ideas.`
    );

    if (alert && found.length > 0) await alertSignals(found);
  } catch (e) {
    lastError = (e as Error).message;
    console.error("[scan] error:", lastError);
  } finally {
    scanning = false;
  }
  return found;
}

// ---- alert with per-symbol per-day dedupe + per-scan cap ----
async function alertSignals(signals: Signal[]): Promise<void> {
  const state = loadState();
  const today = istDateStr();
  let sent = 0;
  for (const s of signals) {
    if (sent >= MAX_ALERTS_PER_SCAN) break;
    if (state.alertedOn[s.symbol] === today) continue; // already alerted today
    const ok = await sendTelegram(messageFor(s));
    if (ok) {
      state.alertedOn[s.symbol] = today;
      sent++;
    }
  }
  saveState(state);
  if (sent > 0) console.log(`[alert] sent ${sent} Telegram signal(s).`);
}

// ---- schedulers ----
// Intraday mode: scan every SCAN_EVERY_MIN minutes during market hours.
// EOD mode: scan once per day at EOD_SCAN_HHMM IST (default 15:20).
let lastIntradayScanAt = 0;
function tick(): void {
  try {
    if (SCAN_MODE === "intraday") {
      if (marketOpenIST() && Date.now() - lastIntradayScanAt >= SCAN_EVERY_MIN * 60_000) {
        lastIntradayScanAt = Date.now();
        runScan(true).catch(() => {});
      }
      return;
    }
    // EOD mode
    const state = loadState();
    const today = istDateStr();
    const target = parseInt(EOD_SCAN_HHMM, 10);
    const nowHHMM = Math.floor(istMinutes() / 60) * 100 + (istMinutes() % 60);
    if (
      isWeekday() &&
      nowHHMM >= target &&
      nowHHMM <= target + 20 &&
      state.lastEodScanDate !== today
    ) {
      state.lastEodScanDate = today;
      saveState(state);
      console.log(`[sched] running EOD scan for ${today}`);
      runScan(true).catch(() => {});
    }
  } catch (e) {
    console.error("[sched] tick error:", (e as Error).message);
  }
}

// ---- HTTP ----
const app = express();
app.use(express.json());

app.get("/", (_req, res) =>
  res
    .type("html")
    .send(
      `<h2>QNIFT Equity Signal Server</h2>` +
        `<p>Angel One → momentum-breakout scanner → Telegram.</p>` +
        `<ul>` +
        `<li><a href="/health">/health</a></li>` +
        `<li><a href="/test-telegram">/test-telegram</a></li>` +
        `<li><a href="/signal">/signal</a> (last scan results)</li>` +
        `<li><a href="/scan">/scan</a> (run a scan now, no alerts)</li>` +
        `<li><a href="/scan?alert=1">/scan?alert=1</a> (run + send alerts)</li>` +
        `</ul>` +
        `<p><i>Screened candidates, not guaranteed trades. Always honour the stop-loss.</i></p>`
    )
);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    source: "angelone",
    hasCreds: angel.hasCreds(),
    telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    universe: INDEX_UNIVERSE,
    universeSize: universe.length,
    scanMode: SCAN_MODE,
    scanInterval: SCAN_INTERVAL,
    marketOpen: marketOpenIST(),
    lastScanAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
    lastScanEvaluated: lastScanCount,
    lastSignals: lastSignals.length,
    lastError,
    note:
      "Screened candidates, not guaranteed trades. Every alert carries a stop-loss.",
  })
);

app.get("/test-telegram", async (_req, res) => {
  const ok = await sendTelegram(
    `✅ QNIFT Equity test — ${fmtIstClock(Date.now())} IST. Telegram is wired up.`
  );
  res.json({ sent: ok });
});

app.get("/signal", (_req, res) =>
  res.json({
    lastScanAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
    count: lastSignals.length,
    signals: lastSignals,
  })
);

app.get("/scan", async (req, res) => {
  const alert = req.query.alert === "1" || req.query.alert === "true";
  const signals = await runScan(alert);
  res.json({ ran: true, alerted: alert, count: signals.length, signals });
});

app.listen(PORT, () => {
  console.log(`QNIFT Equity signal server on :${PORT}`);
  console.log(`  data source: Angel One (creds ${angel.hasCreds() ? "set" : "MISSING"})`);
  console.log(
    `  telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "configured" : "NOT configured"}`
  );
  console.log(`  universe: ${INDEX_UNIVERSE} · mode: ${SCAN_MODE} · interval: ${SCAN_INTERVAL}`);

  // Warm the universe in the background (non-blocking).
  ensureUniverse().catch((e) => {
    lastError = (e as Error).message;
    console.error("universe load error:", lastError);
  });

  // Scheduler: check every minute what to do.
  setInterval(tick, 60_000);
  console.log(
    SCAN_MODE === "intraday"
      ? `  scheduler: intraday scan every ${SCAN_EVERY_MIN} min during market hours`
      : `  scheduler: EOD scan daily at ${EOD_SCAN_HHMM} IST`
  );
});
