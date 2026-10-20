import { describe, expect, it } from "vitest";
import { Limits } from "../src/limits.ts";

describe("Limits", () => {
  it("enforces per-user cooldown and warns once per window", () => {
    let t = 0;
    const l = new Limits(20_000, 3, () => t);
    expect(l.cooldownLeft("u")).toBe(0);
    l.markUsed("u");
    t = 5_000;
    expect(l.cooldownLeft("u")).toBe(15);
    expect(l.shouldWarnCooldown("u")).toBe(true);
    expect(l.shouldWarnCooldown("u")).toBe(false);
    t = 20_001;
    expect(l.cooldownLeft("u")).toBe(0);
  });

  it("locks a channel until unlocked", () => {
    const l = new Limits(0, 3);
    expect(l.tryLock("c")).toBe(true);
    expect(l.tryLock("c")).toBe(false);
    l.unlock("c");
    expect(l.tryLock("c")).toBe(true);
  });

  it("mutes after strikeLimit strikes in 24h, then forgives", () => {
    let t = 0;
    const l = new Limits(0, 3, () => t);
    l.addStrike("u");
    l.addStrike("u");
    expect(l.isMuted("u")).toBe(false);
    l.addStrike("u");
    expect(l.isMuted("u")).toBe(true);
    t = 24 * 3600_000 + 1;
    expect(l.isMuted("u")).toBe(false);
  });
});

describe("busy notice", () => {
  it("tells each user at most once per busy spell, and again after the channel frees up", () => {
    const l = new Limits(20_000, 3);
    expect(l.tryLock("c1")).toBe(true);
    expect(l.shouldWarnBusy("c1", "bob")).toBe(true);
    expect(l.shouldWarnBusy("c1", "bob")).toBe(false);
    expect(l.shouldWarnBusy("c1", "amy")).toBe(true);
    l.unlock("c1");
    expect(l.tryLock("c1")).toBe(true);
    expect(l.shouldWarnBusy("c1", "bob")).toBe(true);
  });
});
