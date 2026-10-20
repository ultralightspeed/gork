import { utcDay } from "./day.ts";

const DAY_MS = 24 * 3600_000;

/** In-memory cooldowns, per-channel single-flight locks, and safety strikes. */
export class Limits {
  private lastUse = new Map<string, number>();
  private warned = new Set<string>();
  private busy = new Set<string>();
  private busyWarned = new Map<string, Set<string>>();
  private budgetWarned = { day: "", users: new Set<string>() };
  private strikes = new Map<string, number[]>();
  private cooldownMs: number;
  private strikeLimit: number;
  private now: () => number;

  constructor(cooldownMs: number, strikeLimit: number, now: () => number = Date.now) {
    this.cooldownMs = cooldownMs;
    this.strikeLimit = strikeLimit;
    this.now = now;
  }

  /** Seconds until the user may ask again; 0 means now. */
  cooldownLeft(userId: string): number {
    const last = this.lastUse.get(userId);
    if (last === undefined) return 0;
    const left = last + this.cooldownMs - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  markUsed(userId: string): void {
    this.lastUse.set(userId, this.now());
    this.warned.delete(userId);
  }

  /** True the first time per cooldown window, so the notice is sent once. */
  shouldWarnCooldown(userId: string): boolean {
    if (this.warned.has(userId)) return false;
    this.warned.add(userId);
    return true;
  }

  tryLock(channelId: string): boolean {
    if (this.busy.has(channelId)) return false;
    this.busy.add(channelId);
    return true;
  }

  unlock(channelId: string): void {
    this.busy.delete(channelId);
    this.busyWarned.delete(channelId);
  }

  /** True the first time a user hits this channel's lock, so "busy" is sent once per user per busy spell. */
  shouldWarnBusy(channelId: string, userId: string): boolean {
    const warned = this.busyWarned.get(channelId) ?? new Set<string>();
    this.busyWarned.set(channelId, warned);
    if (warned.has(userId)) return false;
    warned.add(userId);
    return true;
  }

  /** True the first time a user hits the daily budget cap each (UTC) day. */
  shouldWarnOutOfBudget(userId: string): boolean {
    const day = utcDay(this.now());
    if (this.budgetWarned.day !== day) this.budgetWarned = { day, users: new Set() };
    if (this.budgetWarned.users.has(userId)) return false;
    this.budgetWarned.users.add(userId);
    return true;
  }

  private recent(userId: string): number[] {
    const cutoff = this.now() - DAY_MS;
    const list = (this.strikes.get(userId) ?? []).filter((t) => t > cutoff);
    this.strikes.set(userId, list);
    return list;
  }

  /** Records a blocked request; returns strikes in the last 24h. */
  addStrike(userId: string): number {
    const list = this.recent(userId);
    list.push(this.now());
    return list.length;
  }

  isMuted(userId: string): boolean {
    return this.strikeLimit > 0 && this.recent(userId).length >= this.strikeLimit;
  }
}
