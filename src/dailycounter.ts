import { utcDay } from "./day.ts";

/** Counts uses per UTC day (images, videos, fallback searches); in memory, so a restart resets it. */
export class DailyCounter {
  private day = "";
  private count = 0;
  private perDay: number;
  private now: () => Date;

  constructor(perDay: number, now: () => Date = () => new Date()) {
    this.perDay = perDay;
    this.now = now;
  }

  /** Whether a slot is left today, without claiming it. */
  available(): boolean {
    this.roll();
    return this.count < this.perDay;
  }

  /** Claims one slot for today; false when today's are used up. */
  take(): boolean {
    this.roll();
    if (this.count >= this.perDay) return false;
    this.count++;
    return true;
  }

  private roll(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
  }
}
