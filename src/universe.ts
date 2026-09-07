// Build the tradable universe + map symbols -> Angel One tokens, and apply the
// anti-junk quality gates. Mirrors the Python scanner's universe.py.
//
// Primary anti-fraud defence: only NSE index constituents (default Nifty 100)
// are considered — SME/penny/pump shells (the "Varanium Cloud" problem) are not
// members, so they never enter the pipeline. Secondary: EQ-series only, plus
// price/volume/turnover liquidity gates applied on real candles.

import type { Candle } from "./indicators.js";

const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const INDEX_CSV_URLS: Record<string, string> = {
  NIFTY50: "https://archives.nseindia.com/content/indices/ind_nifty50list.csv",
  NIFTY100: "https://archives.nseindia.com/content/indices/ind_nifty100list.csv",
  NIFTY200: "https://archives.nseindia.com/content/indices/ind_nifty200list.csv",
  NIFTY500: "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
};

const HTTP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "text/csv,application/json,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

// Safety net if NSE blocks the CSV fetch: highly liquid, long-listed large caps.
const FALLBACK_SYMBOLS = [
  "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "ITC", "LT", "SBIN",
  "AXISBANK", "KOTAKBANK", "HINDUNILVR", "BHARTIARTL", "BAJFINANCE", "MARUTI",
  "ASIANPAINT", "SUNPHARMA", "TITAN", "ULTRACEMCO", "WIPRO", "TATAMOTORS",
  "TATASTEEL", "POWERGRID", "NTPC", "HCLTECH", "NESTLEIND", "TECHM",
  "ADANIPORTS", "GRASIM", "JSWSTEEL", "COALINDIA", "BAJAJFINSV", "HDFCLIFE",
  "DRREDDY", "CIPLA", "EICHERMOT", "BRITANNIA", "DIVISLAB", "HEROMOTOCO",
  "INDUSINDBK", "APOLLOHOSP", "TATACONSUM", "BPCL", "ONGC", "SBILIFE",
  "ADANIENT", "HINDALCO", "BAJAJ-AUTO", "M&M", "SHRIRAMFIN", "LTIM",
];

export interface Instrument {
  symbol: string;
  token: string;
  name: string;
}

export interface QualityConfig {
  minPrice: number;
  maxPrice: number;
  minAvgVolume: number;
  minAvgTurnoverCr: number;
  liquidityLookback: number;
}

async function fetchIndexSymbols(indexName: string): Promise<Set<string>> {
  const url = INDEX_CSV_URLS[indexName];
  if (!url) throw new Error(`Unknown index universe: ${indexName}`);
  try {
    const res = await fetch(url, { headers: HTTP_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const symbols = parseSymbolColumn(text);
    if (symbols.size > 0) return symbols;
  } catch (e) {
    console.warn(
      `[universe] WARN: could not fetch ${indexName} list (${(e as Error).message}). ` +
        `Falling back to bundled blue-chip list.`
    );
  }
  return new Set(FALLBACK_SYMBOLS);
}

function parseSymbolColumn(csv: string): Set<string> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return new Set();
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = header.indexOf("symbol");
  if (idx === -1) return new Set();
  const out = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const sym = (cols[idx] || "").trim().toUpperCase();
    if (sym) out.add(sym);
  }
  return out;
}

async function fetchScripMaster(): Promise<any[]> {
  const res = await fetch(SCRIP_MASTER_URL, { headers: HTTP_HEADERS });
  if (!res.ok) throw new Error(`scrip master HTTP ${res.status}`);
  return (await res.json()) as any[];
}

export async function loadUniverse(
  indexName: string,
  exchange = "NSE"
): Promise<Instrument[]> {
  const [wanted, master] = await Promise.all([
    fetchIndexSymbols(indexName),
    fetchScripMaster(),
  ]);

  const instruments: Instrument[] = [];
  const seen = new Set<string>();
  for (const row of master) {
    if (row?.exch_seg !== exchange) continue;
    const tradingsymbol = String(row?.symbol ?? "");
    if (!tradingsymbol.endsWith("-EQ")) continue; // EQ-series cash equity only
    const base = String(row?.name ?? "").trim().toUpperCase();
    if (!wanted.has(base) || seen.has(base)) continue;
    const token = String(row?.token ?? "").trim();
    if (!token) continue;
    instruments.push({ symbol: base, token, name: base });
    seen.add(base);
  }
  instruments.sort((a, b) => a.symbol.localeCompare(b.symbol));
  console.log(
    `[universe] ${indexName}: matched ${instruments.length} EQ instruments on ` +
      `${exchange} (from ${wanted.size} index members).`
  );
  return instruments;
}

/** Liquidity/price quality gate on a stock's candle history. */
export function passesLiquidity(
  candles: Candle[],
  cfg: QualityConfig
): { ok: boolean; reason: string } {
  if (!candles || candles.length < cfg.liquidityLookback) {
    return { ok: false, reason: "insufficient history" };
  }
  const recent = candles.slice(-cfg.liquidityLookback);
  const lastPrice = candles[candles.length - 1].close;
  const avgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const avgTurnoverCr =
    recent.reduce((s, c) => s + c.close * c.volume, 0) / recent.length / 1e7;

  if (lastPrice < cfg.minPrice) return { ok: false, reason: `price ${lastPrice.toFixed(1)} < min` };
  if (lastPrice > cfg.maxPrice) return { ok: false, reason: `price ${lastPrice.toFixed(1)} > max` };
  if (avgVol < cfg.minAvgVolume) return { ok: false, reason: `avg vol ${avgVol.toFixed(0)} < min` };
  if (avgTurnoverCr < cfg.minAvgTurnoverCr)
    return { ok: false, reason: `turnover ₹${avgTurnoverCr.toFixed(1)}cr < min` };
  return { ok: true, reason: "ok" };
}
