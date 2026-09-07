// IST time helpers (NSE trades in Asia/Kolkata, UTC+5:30).

export function toIst(now = new Date()): Date {
  return new Date(now.getTime() + (5 * 60 + 30) * 60000);
}

export function istDateStr(d = new Date()): string {
  const ist = toIst(d);
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}`;
}

export function istMinutes(now = new Date()): number {
  const ist = toIst(now);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

export function isWeekday(now = new Date()): boolean {
  const day = toIst(now).getUTCDay();
  return day !== 0 && day !== 6;
}

// NSE equity market hours 09:15–15:30 IST, Mon–Fri.
export function marketOpenIST(now = new Date()): boolean {
  if (!isWeekday(now)) return false;
  const m = istMinutes(now);
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}

export function fmtIstClock(ms: number): string {
  const ist = toIst(new Date(ms));
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}`;
}
