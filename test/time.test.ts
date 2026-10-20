import { describe, expect, it } from "vitest";
import { formatLocalNow, localToUtc } from "../src/time.ts";

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const NY = "America/New_York";

describe("localToUtc", () => {
  it.each([
    ["is the identity in UTC", "2026-11-06T20:00", "UTC", "2026-11-06T20:00:00.000Z"],
    ["accepts a space instead of the T", "2026-11-06 20:00", "UTC", "2026-11-06T20:00:00.000Z"],
    ["applies the standard offset (New York in January is UTC-5)", "2026-01-15T20:00", NY, "2026-01-16T01:00:00.000Z"],
    ["applies the summer offset (New York in July is UTC-4)", "2026-07-15T20:00", NY, "2026-07-16T00:00:00.000Z"],
    ["handles zones east of UTC", "2026-11-06T20:00", "Asia/Tokyo", "2026-11-06T11:00:00.000Z"],
    ["handles half-hour offsets", "2026-11-06T20:00", "Asia/Kolkata", "2026-11-06T14:30:00.000Z"],
    [
      "follows the southern hemisphere's seasons (Sydney, before and after October)",
      "2026-10-05T12:00",
      "Australia/Sydney",
      "2026-10-05T01:00:00.000Z",
    ],
    ["accepts a leap day in a leap year", "2028-02-29T10:00", "UTC", "2028-02-29T10:00:00.000Z"],
  ])("%s", (_what, local, zone, utc) => {
    expect(iso(localToUtc(local, zone))).toBe(utc);
  });

  it("spring forward (New York, 2026-03-08): winter time before 02:00, summer time after 03:00, nothing between", () => {
    expect(iso(localToUtc("2026-03-08T01:30", NY))).toBe("2026-03-08T06:30:00.000Z");
    expect(iso(localToUtc("2026-03-08T03:30", NY))).toBe("2026-03-08T07:30:00.000Z");
    expect(localToUtc("2026-03-08T02:30", NY)).toBeNull();
    expect(localToUtc("2026-10-04T02:30", "Australia/Sydney")).toBeNull();
  });

  it("fall back (New York, 2026-11-01): summer time before and for the first 01:30, winter time after", () => {
    expect(iso(localToUtc("2026-11-01T00:30", NY))).toBe("2026-11-01T04:30:00.000Z");
    expect(iso(localToUtc("2026-11-01T01:30", NY))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(localToUtc("2026-11-01T02:30", NY))).toBe("2026-11-01T07:30:00.000Z");
  });

  it("returns null for text that is not a local date-time, or a date that does not exist", () => {
    for (const bad of [
      "",
      "tomorrow 8pm",
      "2026-11-06",
      "2026-11-06T20",
      "2026-11-06T20:00:00",
      "2026-11-06T20:00Z",
      "2026-11-06T20:00+02:00",
      "2026-13-06T20:00",
      "2026-02-30T20:00",
      "2027-02-29T10:00",
      "2026-11-06T24:00",
      "2026-11-06T20:60",
    ]) {
      expect(localToUtc(bad, "UTC"), bad).toBeNull();
    }
  });
});

describe("formatLocalNow", () => {
  it("names the weekday, date and time in the zone, rolling the date over and writing midnight as 00:00", () => {
    // 2026-10-19 is a Monday; 18:05 UTC is 14:05 in New York (daylight time).
    const now = new Date("2026-10-19T18:05:30Z");
    expect(formatLocalNow(now, NY)).toBe("Monday 2026-10-19 14:05");
    expect(formatLocalNow(new Date("2026-10-19T23:30:00Z"), "Asia/Tokyo")).toBe("Tuesday 2026-10-20 08:30");
    expect(formatLocalNow(new Date("2026-10-20T00:00:00Z"), "UTC")).toBe("Tuesday 2026-10-20 00:00");
  });
});
