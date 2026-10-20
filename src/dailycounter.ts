import { utcDay } from "./day.ts";

/** Counts uses per UTC day (images, videos); in memory, so a restart resets it. */
export class DailyCounter {
  private day = "";
  private count = 0;
  private perDay: number;
  private now: () => Date;

  constructor(perDay: number, now: () => Date = () => new Date()) {
    this.perDay = perDay;
    this.now = now;
  }

  /** Claims one slot for today; false when today's are used up. */
  take(): boolean {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    if (this.count >= this.perDay) return false;
    this.count++;
    return true;
  }
}
