import { describe, expect, it } from "vitest";
import { parseEvent, pickVoiceChannel } from "../src/event.ts";

// Monday 2026-10-19, 12:00 UTC. In New York that is 08:00 (daylight time).
const now = new Date("2026-10-19T12:00:00Z");
const utc = { now, timeZone: "UTC" };
const ny = { now, timeZone: "America/New_York" };

describe("parseEvent", () => {
  it("accepts a name and a start and gives an External-by-default event at 'Discord'", () => {
    expect(parseEvent({ name: " Raid night ", start: "2026-10-23T20:00" }, utc)).toEqual({
      name: "Raid night",
      start: new Date("2026-10-23T20:00:00Z"),
      end: null,
      where: { kind: "location", text: "Discord" },
      description: null,
    });
  });

  it("reads start and end as wall-clock times in TIMEZONE", () => {
    const ev = parseEvent({ name: "Raid", start: "2026-10-23T20:00", end: "2026-10-23T22:30" }, ny);
    expect(ev).toMatchObject({
      start: new Date("2026-10-24T00:00:00Z"),
      end: new Date("2026-10-24T02:30:00Z"),
    });
  });

  it("keeps a location, a voice channel or a description when given", () => {
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", location: " Ironforge bank " }, utc)).toMatchObject({
      where: { kind: "location", text: "Ironforge bank" },
    });
    expect(
      parseEvent(
        { name: "n", start: "2026-10-23T20:00", voice_channel: "#Raid Voice", description: " bring flasks " },
        utc,
      ),
    ).toMatchObject({ where: { kind: "voice", channel: "#Raid Voice" }, description: "bring flasks" });
  });

  it("drops invisible characters from its text before checking it", () => {
    expect(typeof parseEvent({ name: "\u200b", start: "2026-10-23T20:00" }, utc)).toBe("string");
    const ev = parseEvent(
      { name: "Ra\u200bid", start: "2026-10-23T20:00", location: "\u202e", description: "b\u200bring" },
      utc,
    );
    expect(ev).toMatchObject({ name: "Raid", where: { kind: "location", text: "Discord" }, description: "bring" });
  });

  it("treats blank optional fields as not given", () => {
    expect(
      parseEvent(
        { name: "n", start: "2026-10-23T20:00", location: "  ", voice_channel: "", description: " ", end: "" },
        utc,
      ),
    ).toMatchObject({ where: { kind: "location", text: "Discord" }, description: null, end: null });
  });

  it("takes the first of a repeated local time and rejects a skipped one", () => {
    const fall = new Date("2026-10-19T12:00:00Z");
    expect(
      parseEvent({ name: "n", start: "2026-11-01T01:30" }, { now: fall, timeZone: "America/New_York" }),
    ).toMatchObject({
      start: new Date("2026-11-01T05:30:00Z"),
    });
    const spring = new Date("2026-03-01T12:00:00Z");
    const r = parseEvent({ name: "n", start: "2026-03-08T02:30" }, { now: spring, timeZone: "America/New_York" });
    expect(r).toMatch(/start/);
  });

  it("rejects a bad name with the limit", () => {
    for (const name of [undefined, "", "   ", 5, "x".repeat(101)]) {
      expect(parseEvent({ name, start: "2026-10-23T20:00" }, utc), String(name)).toMatch(/name must be 1-100/);
    }
  });

  it("rejects a start that is missing or not a local date-time, and says what the format is", () => {
    for (const start of [undefined, "", "friday 8pm", "2026-10-23", "2026-10-23T20:00Z", "2026-10-23T20:00:00+02:00"]) {
      const r = parseEvent({ name: "n", start }, utc);
      expect(r, String(start)).toMatch(/start must be/);
    }
  });

  it("rejects a start in the past or too soon to create, naming the local time so the model can fix its date", () => {
    const tooSoon = /start must be at least \d+ minutes in the future/;
    expect(parseEvent({ name: "n", start: "2026-10-19T11:00" }, utc)).toMatch(tooSoon);
    expect(parseEvent({ name: "n", start: "2026-10-19T12:05" }, utc)).toMatch(tooSoon);
    expect(parseEvent({ name: "n", start: "2026-10-19T12:06" }, utc)).toMatchObject({ name: "n" });
    expect(parseEvent({ name: "n", start: "2026-10-18T20:00" }, ny)).toContain("Monday 2026-10-19 08:00");
  });

  it("rejects a start more than a year away, but accepts one just inside", () => {
    expect(parseEvent({ name: "n", start: "2027-10-20T12:00" }, utc)).toMatch(/within the next year/);
    expect(parseEvent({ name: "n", start: "2027-10-19T11:00" }, utc)).toMatchObject({ name: "n" });
  });

  it("rejects an end that is not after the start, or not a local date-time", () => {
    for (const end of ["2026-10-23T19:00", "2026-10-23T20:00"]) {
      expect(parseEvent({ name: "n", start: "2026-10-23T20:00", end }, utc), end).toMatch(/end must be after start/);
    }
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", end: "late" }, utc)).toMatch(/end must be/);
  });

  it("rejects naming both a location and a voice channel, saying to pick one", () => {
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", location: "a", voice_channel: "b" }, utc)).toMatch(
      /only one of location or voice_channel/,
    );
  });

  it("rejects a location, voice channel or description over its limit", () => {
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", location: "x".repeat(101) }, utc)).toMatch(
      /location must be 1-100/,
    );
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", voice_channel: "x".repeat(101) }, utc)).toMatch(
      /voice_channel must be 1-100/,
    );
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", description: "x".repeat(1001) }, utc)).toMatch(
      /description must be at most 1000/,
    );
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", description: "x".repeat(1000) }, utc)).toMatchObject({
      name: "n",
    });
    expect(parseEvent({ name: "n", start: "2026-10-23T20:00", location: 5 }, utc)).toMatch(/location must be/);
  });
});

describe("pickVoiceChannel", () => {
  const channels = [
    { id: "1", name: "Raid Voice", stage: false },
    { id: "2", name: "Town Hall", stage: true },
    { id: "3", name: "General", stage: false },
  ];

  it("matches by name, ignoring case, spacing and a leading #", () => {
    expect(pickVoiceChannel("raid voice", channels)?.id).toBe("1");
    expect(pickVoiceChannel("  #Raid Voice ", channels)?.id).toBe("1");
    expect(pickVoiceChannel("Town Hall", channels)).toEqual({ id: "2", name: "Town Hall", stage: true });
  });

  it("returns null rather than guess: partial name, unknown name, or two channels sharing the name", () => {
    expect(pickVoiceChannel("raid", channels)).toBeNull();
    expect(pickVoiceChannel("Lounge", channels)).toBeNull();
    expect(pickVoiceChannel("general", [...channels, { id: "4", name: "GENERAL", stage: false }])).toBeNull();
    expect(pickVoiceChannel("x", [])).toBeNull();
  });
});
