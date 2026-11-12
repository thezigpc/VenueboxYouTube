// Wall-clock helpers for a named time zone (the venue's, or Pacific for YouTube's quota day).

/** The zone's local date and hour at `t`. */
export function zonedParts(tz: string, t: number): { y: number; m: number; d: number; hour: number; minute: number; date: string } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return { y, m, d, hour: Number(p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}

/** Milliseconds the zone is ahead of UTC at `t`. */
function offset(tz: string, t: number): number {
  const p = zonedParts(tz, t);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
  return asUtc - Math.floor(t / 60_000) * 60_000;
}

/** The next local midnight in `tz` after `t` (DST-safe). */
export function nextMidnight(tz: string, t: number): number {
  const p = zonedParts(tz, t);
  const wall = Date.UTC(p.y, p.m - 1, p.d + 1);
  let guess = wall - offset(tz, t);
  guess = wall - offset(tz, guess);
  return guess;
}

/** A zone name that Intl accepts, else the fallback. */
export function validZone(tz: string | null | undefined, fallback: string): string {
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

export const PACIFIC = "America/Los_Angeles";
export const serverTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
