// Momentum-breakout signal logic (long-only), ported from the Python scanner.
//
//   TREND   : close > EMA_fast > EMA_slow (and > EMA_trend when available)
//   TRIGGER : close breaks / is within tolerance of the N-day high
//   VOLUME  : today's volume >= volSpikeMult x average volume
//   MOMENTUM: RSI in [rsiMin, rsiMax]
//
// Trade construction is ATR-based so stop/target adapt to each stock's own
// volatility. A setup is emitted only if reward:risk >= minRiskReward and the
// stop is not wider than maxStopPct. Nothing here is a guarantee — the stop-loss
// bounds the loss on the (many) ideas that will not work out.

import {
  atr,
  avgVolumePrev,
  ema,
  rollingHighPrev,
  rsi,
  type Candle,
} from "./indicators.js";

export interface SignalConfig {
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  atrPeriod: number;
  rsiPeriod: number;
  rsiMin: number;
  rsiMax: number;
  breakoutLookback: number;
  breakoutTolerance: number;
  volSpikeMult: number;
  liquidityLookback: number;
  atrStopMult: number;
  atrTargetMult: number;
  minRiskReward: number;
  maxStopPct: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  emaFast: 20,
  emaSlow: 50,
  emaTrend: 200,
  atrPeriod: 14,
  rsiPeriod: 14,
  rsiMin: 55,
  rsiMax: 78,
  breakoutLookback: 20,
  breakoutTolerance: 0.01,
  volSpikeMult: 1.5,
  liquidityLookback: 20,
  atrStopMult: 1.5,
  atrTargetMult: 3.0,
  minRiskReward: 1.8,
  maxStopPct: 0.06,
};

export interface Signal {
  symbol: string;
  date: string;
  entry: number;
  stopLoss: number;
  target: number;
  riskReward: number;
  stopPct: number;
  targetPct: number;
  rsi: number;
  volMultiple: number;
  atrPct: number;
  score: number;
  note: string;
}

const round = (x: number, n = 2) => {
  const f = 10 ** n;
  return Math.round(x * f) / f;
};

/** Evaluate the signal on the LAST candle of `candles`. Returns a Signal or null. */
export function evaluate(
  symbol: string,
  candles: Candle[],
  cfg: SignalConfig = DEFAULT_SIGNAL_CONFIG
): Signal | null {
  const minBars = Math.max(cfg.emaSlow, cfg.breakoutLookback, cfg.atrPeriod) + 5;
  if (!candles || candles.length < minBars) return null;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const vols = candles.map((c) => c.volume);

  const emaFast = ema(closes, cfg.emaFast);
  const emaSlow = ema(closes, cfg.emaSlow);
  const emaTrend = candles.length >= cfg.emaTrend ? ema(closes, cfg.emaTrend) : null;
  const rsiArr = rsi(closes, cfg.rsiPeriod);
  const atrArr = atr(candles, cfg.atrPeriod);
  const priorHigh = rollingHighPrev(highs, cfg.breakoutLookback);
  const avgVol = avgVolumePrev(vols, cfg.liquidityLookback);

  const i = candles.length - 1;
  const price = closes[i];
  const _atr = atrArr[i];
  if (!(price > 0) || !(_atr > 0)) return null;

  // ── conditions ──────────────────────────────────────────────────────────
  let trendOk = price > emaFast[i] && emaFast[i] > emaSlow[i];
  if (emaTrend) trendOk = trendOk && price > emaTrend[i];

  const hh = priorHigh[i];
  const breakoutOk = Number.isFinite(hh) && price >= hh * (1 - cfg.breakoutTolerance);

  const av = Number.isFinite(avgVol[i]) ? avgVol[i] : 0;
  const volMult = av > 0 ? vols[i] / av : 0;
  const volumeOk = volMult >= cfg.volSpikeMult;

  const _rsi = rsiArr[i];
  const rsiOk = _rsi >= cfg.rsiMin && _rsi <= cfg.rsiMax;

  if (!(trendOk && breakoutOk && volumeOk && rsiOk)) return null;

  // ── trade construction ────────────────────────────────────────────────
  const entry = price;
  const stop = entry - cfg.atrStopMult * _atr;
  const target = entry + cfg.atrTargetMult * _atr;
  const risk = entry - stop;
  const reward = target - entry;
  if (risk <= 0) return null;
  const rr = reward / risk;
  const stopPct = risk / entry;
  const targetPct = reward / entry;
  if (rr < cfg.minRiskReward) return null;
  if (stopPct > cfg.maxStopPct) return null;

  // ── composite score for ranking ────────────────────────────────────────
  const rsiCentered = 1 - Math.abs(_rsi - 65) / 25; // peak near RSI 65
  const score = Math.min(volMult, 5) * 0.4 + rr * 0.4 + Math.max(rsiCentered, 0) * 0.2;

  const d = candles[i].time ? new Date(candles[i].time) : new Date();
  return {
    symbol,
    date: d.toISOString().slice(0, 10),
    entry: round(entry),
    stopLoss: round(stop),
    target: round(target),
    riskReward: round(rr),
    stopPct: round(stopPct * 100, 2),
    targetPct: round(targetPct * 100, 2),
    rsi: round(_rsi, 1),
    volMultiple: round(volMult, 2),
    atrPct: round((_atr / entry) * 100, 2),
    score: round(score, 3),
    note: "momentum-breakout (long)",
  };
}
