// Pure technical indicators (no external TA lib), ported from the Python scanner.
// All functions return arrays aligned to the input length; warmup slots are NaN.

export interface Candle {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Exponential moving average (recursive, adjust=false — matches pandas ewm). */
export function ema(values: number[], span: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length === 0) return out;
  const alpha = 2 / (span + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length < 2) return out;
  const alpha = 1 / period;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    if (i === 1) {
      avgGain = gain;
      avgLoss = loss;
    } else {
      avgGain = gain * alpha + avgGain * (1 - alpha);
      avgLoss = loss * alpha + avgLoss * (1 - alpha);
    }
    if (avgLoss === 0) {
      out[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

/** Average True Range (Wilder). */
export function atr(candles: Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length === 0) return out;
  const alpha = 1 / period;
  let prevAtr = NaN;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let tr: number;
    if (i === 0) {
      tr = c.high - c.low;
      prevAtr = tr;
    } else {
      const pc = candles[i - 1].close;
      tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
      prevAtr = tr * alpha + prevAtr * (1 - alpha);
    }
    out[i] = prevAtr;
  }
  return out;
}

/** Highest high over the PREVIOUS `lookback` bars (excludes the current bar). */
export function rollingHighPrev(highs: number[], lookback: number): number[] {
  const out = new Array<number>(highs.length).fill(NaN);
  for (let i = 0; i < highs.length; i++) {
    if (i < lookback) continue;
    let hh = -Infinity;
    for (let j = i - lookback; j < i; j++) hh = Math.max(hh, highs[j]);
    out[i] = hh;
  }
  return out;
}

/** Average volume over the PREVIOUS `lookback` bars (excludes the current bar). */
export function avgVolumePrev(volumes: number[], lookback: number): number[] {
  const out = new Array<number>(volumes.length).fill(NaN);
  for (let i = 0; i < volumes.length; i++) {
    if (i < lookback) continue;
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += volumes[j];
    out[i] = sum / lookback;
  }
  return out;
}
