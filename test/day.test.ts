import { afterEach, describe, expect, it, vi } from "vitest";
import { utcDay } from "../src/day.ts";

afterEach(() => vi.useRealTimers());

describe("utcDay", () => {
  it("is the UTC calendar date of a Date or a timestamp, whatever the local time zone, and defaults to now", () => {
    expect(utcDay(new Date("2026-10-19T23:59:59Z"))).toBe("2026-10-19");
    expect(utcDay(new Date("2026-10-20T00:00:00Z"))).toBe("2026-10-20");
    expect(utcDay(Date.parse("2026-01-02T03:04:05Z"))).toBe("2026-01-02");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T23:59:59Z"));
    expect(utcDay()).toBe("2026-05-06");
  });
});
