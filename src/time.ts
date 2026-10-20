// Wall-clock time in an IANA time zone, using only Intl (no date library).

const DAY_MS = 86_400_000;

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The calendar date and clock time a UTC moment has on the wall in `timeZone`. */
function wallTime(when: number, timeZone: string): Wall & { weekday: string } {
  // hourCycle h23 prints midnight as 00; hour12:false prints 24 in some engines.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(when));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

const wallAsUtc = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** How far the zone's wall clock is ahead of UTC at this moment, in ms. `when` is a whole number of seconds. */
const offsetAt = (when: number, timeZone: string): number => wallAsUtc(wallTime(when, timeZone)) - when;

/** True when Intl accepts the name as a time zone (e.g. "UTC", "America/New_York"). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/**
 * Turns a local date-time ("YYYY-MM-DDTHH:MM", no offset) in `timeZone` into the UTC moment it names.
 * Returns null when the text isn't in that form or names a date or time that doesn't exist, including a time that
 * a clock change skips. A time that happens twice (the clocks go back) means the first of the two.
 */
export function localToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL.exec(local);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const back = new Date(wall);
  // Date.UTC rolls 2026-02-30 over to March; reading the fields back catches that, and hour 24 or minute 60.
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute
  ) {
    return null;
  }
  // The zone's offset a day either side of the wall time is the offset before and after any clock change nearby.
  // A candidate is real only if the zone's wall clock shows the requested time at that moment.
  const candidates = new Set([wall - offsetAt(wall - DAY_MS, timeZone), wall - offsetAt(wall + DAY_MS, timeZone)]);
  const real = [...candidates].filter((utc) => offsetAt(utc, timeZone) === wall - utc);
  return real.length ? new Date(Math.min(...real)) : null;
}

/** "Monday 2026-10-19 14:05": the weekday, date and time on the wall in `timeZone` at `when`. */
export function formatLocalNow(when: Date, timeZone: string): string {
  const w = wallTime(Math.floor(when.getTime() / 1000) * 1000, timeZone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.weekday} ${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)}`;
}
