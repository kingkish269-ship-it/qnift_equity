// Angel One SmartAPI REST client.
//
// Auth is fully unattended: we store the TOTP *secret* (base32) and generate the
// current 6-digit code with otplib on every login — you never type a Google
// Authenticator code into the server. The JWT is cached and re-used until it
// looks stale, then we transparently re-login.

import { authenticator } from "otplib";
import type { Candle } from "./indicators.js";

const BASE = "https://apiconnect.angelone.in";
const LOGIN_PATH = "/rest/auth/angelbroking/user/v1/loginByPassword";
const CANDLE_PATH = "/rest/secure/angelbroking/historical/v1/getCandleData";
const QUOTE_PATH = "/rest/secure/angelbroking/market/v1/quote/";

export interface AngelCreds {
  apiKey: string;
  clientCode: string;
  mpin: string;
  totpSecret: string;
}

// Minutes a session token is trusted before we proactively re-login.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export class AngelClient {
  private creds: AngelCreds;
  private jwt: string | null = null;
  private loginAt = 0;

  constructor(creds: AngelCreds) {
    this.creds = creds;
  }

  hasCreds(): boolean {
    return !!(
      this.creds.apiKey &&
      this.creds.clientCode &&
      this.creds.mpin &&
      this.creds.totpSecret
    );
  }

  private baseHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": this.creds.apiKey,
    };
  }

  /** Log in and cache the JWT. Generates the TOTP from the stored secret. */
  async login(): Promise<void> {
    if (!this.hasCreds()) throw new Error("Angel One credentials not set");
    const totp = authenticator.generate(this.creds.totpSecret);
    const res = await fetch(`${BASE}${LOGIN_PATH}`, {
      method: "POST",
      headers: this.baseHeaders(),
      body: JSON.stringify({
        clientcode: this.creds.clientCode,
        password: this.creds.mpin,
        totp,
      }),
    });
    const j: any = await res.json().catch(() => null);
    const jwt = j?.data?.jwtToken;
    if (!j?.status || !jwt) {
      throw new Error(`Angel login failed: ${j?.message || res.status}`);
    }
    this.jwt = jwt.startsWith("Bearer ") ? jwt.slice(7) : jwt;
    this.loginAt = Date.now();
  }

  private async ensureSession(): Promise<void> {
    if (!this.jwt || Date.now() - this.loginAt > SESSION_TTL_MS) {
      await this.login();
    }
  }

  private authHeaders(): Record<string, string> {
    return { ...this.baseHeaders(), Authorization: `Bearer ${this.jwt}` };
  }

  /**
   * Fetch historical OHLCV candles for one instrument token.
   * `interval` e.g. ONE_DAY, FIFTEEN_MINUTE, FIVE_MINUTE.
   */
  async getCandles(
    symboltoken: string,
    interval: string,
    days: number,
    exchange = "NSE"
  ): Promise<Candle[]> {
    await this.ensureSession();
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) => {
      const ist = new Date(d.getTime() + (5 * 60 + 30) * 60000);
      const p = (n: number) => `${n}`.padStart(2, "0");
      return (
        `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())} ` +
        `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}`
      );
    };
    const body = {
      exchange,
      symboltoken: String(symboltoken),
      interval,
      fromdate: fmt(from),
      todate: fmt(to),
    };
    const res = await fetch(`${BASE}${CANDLE_PATH}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    const j: any = await res.json().catch(() => null);
    const rows: any[] = j?.data || [];
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        time: new Date(r[0]).getTime(),
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5] || 0,
      }))
      .filter((c) => Number.isFinite(c.close));
  }

  /** Batch last-traded-price for many tokens (chunks of 50). Returns {token: ltp}. */
  async getLtpBatch(tokens: string[], exchange = "NSE"): Promise<Record<string, number>> {
    await this.ensureSession();
    const out: Record<string, number> = {};
    for (let i = 0; i < tokens.length; i += 50) {
      const chunk = tokens.slice(i, i + 50).map(String);
      const res = await fetch(`${BASE}${QUOTE_PATH}`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ mode: "LTP", exchangeTokens: { [exchange]: chunk } }),
      });
      const j: any = await res.json().catch(() => null);
      const fetched: any[] = j?.data?.fetched || [];
      for (const item of fetched) {
        out[String(item.symbolToken)] = +item.ltp || 0;
      }
      await sleep(300);
    }
    return out;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
