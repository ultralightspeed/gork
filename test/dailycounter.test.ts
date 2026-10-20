import { describe, expect, it } from "vitest";
import { DailyCounter } from "../src/dailycounter.ts";

describe("DailyCounter", () => {
  it("gives out its slots once per UTC day and starts over the next day", () => {
    let now = new Date("2026-10-19T23:00:00Z");
    const counter = new DailyCounter(2, () => now);
    expect([counter.take(), counter.take(), counter.take()]).toEqual([true, true, false]);
    now = new Date("2026-10-20T00:00:01Z");
    expect(counter.take()).toBe(true);
  });

  it("gives out nothing when the allowance is zero", () => {
    expect(new DailyCounter(0).take()).toBe(false);
  });
});
