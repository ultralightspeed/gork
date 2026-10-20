import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { utcDay } from "./day.ts";

/** Daily USD ledger (UTC day): reserve before a call, commit the actual cost after. */
export class Budget {
  private day = "";
  private spent = 0;
  private reserved = 0;
  private file: string;
  private cap: number;
  private now: () => Date;
  private warn: (line: string) => void;

  constructor(
    file: string,
    capUsd: number,
    now: () => Date = () => new Date(),
    warn: (line: string) => void = (line) => console.warn(`[gork] ${line}`),
  ) {
    this.file = file;
    this.cap = capUsd;
    this.now = now;
    this.warn = warn;
    this.load();
  }

  get capUsd(): number {
    return this.cap;
  }

  get spentToday(): number {
    this.roll();
    return this.spent;
  }

  tryReserve(usd: number): boolean {
    this.roll();
    // NaN would pass the comparison below and then poison the ledger, so an amount that isn't a number is refused.
    if (!(usd >= 0) || !Number.isFinite(usd)) return false;
    if (this.spent + this.reserved + usd > this.cap) return false;
    this.reserved += usd;
    return true;
  }

  commit(reservedUsd: number, actualUsd: number): void {
    this.roll();
    this.reserved = Math.max(0, this.reserved - reservedUsd);
    // A cost that isn't a number would make spent NaN, and every later tryReserve would pass: count the reservation.
    if (!(actualUsd >= 0) || !Number.isFinite(actualUsd))
      this.warn("a cost was not a number; counted its reservation instead");
    this.spent += actualUsd >= 0 && Number.isFinite(actualUsd) ? actualUsd : reservedUsd;
    this.persist();
  }

  private today(): string {
    return utcDay(this.now());
  }

  private roll(): void {
    const d = this.today();
    if (d === this.day) return;
    this.day = d;
    this.spent = 0;
    this.persist();
  }

  private load(): void {
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { day?: string; spentUsd?: number };
      if (j.day === this.today() && typeof j.spentUsd === "number") {
        this.day = j.day;
        this.spent = j.spentUsd;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.warn("ledger unreadable, starting today at $0");
    }
    this.roll();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ day: this.day, spentUsd: this.spent }));
    renameSync(tmp, this.file);
  }
}
