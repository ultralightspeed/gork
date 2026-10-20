import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from "discord.js";
import { describe, expect, it } from "vitest";
import { createGuildEvent, eventOptions } from "../src/discord-event.ts";
import type { ScheduledEvent } from "../src/event.ts";

const start = new Date("2026-10-23T20:00:00Z");
const external: ScheduledEvent = {
  name: "Raid night",
  start,
  end: null,
  where: { kind: "location", text: "Ironforge" },
  description: "bring flasks",
};
const voice: ScheduledEvent = { ...external, where: { kind: "voice", channel: "raid voice" }, description: null };
const channels = [
  { id: "10", name: "Raid Voice", stage: false },
  { id: "11", name: "Town Hall", stage: true },
];

describe("eventOptions", () => {
  it("makes a server-only External event at a location, ending two hours after the start by default", () => {
    expect(eventOptions(external, channels)).toEqual({
      fellBack: false,
      options: {
        name: "Raid night",
        scheduledStartTime: start,
        scheduledEndTime: new Date("2026-10-23T22:00:00Z"),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: "Ironforge" },
        description: "bring flasks",
      },
    });
  });

  it("holds a Voice event in the channel it names, with no end unless one was asked for", () => {
    const { options, fellBack } = eventOptions(voice, channels);
    expect(fellBack).toBe(false);
    expect(options).toEqual({
      name: "Raid night",
      scheduledStartTime: start,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.Voice,
      channel: "10",
    });
    expect(options).not.toHaveProperty("description");
    expect(options).not.toHaveProperty("scheduledEndTime");
  });

  it("keeps an end that was asked for, External or Voice", () => {
    const end = new Date("2026-10-23T21:00:00Z");
    expect(eventOptions({ ...external, end }, channels).options.scheduledEndTime).toEqual(end);
    expect(eventOptions({ ...voice, end }, channels).options.scheduledEndTime).toEqual(end);
  });

  it("holds a Stage channel's event as a Stage event", () => {
    const { options } = eventOptions({ ...voice, where: { kind: "voice", channel: "town hall" } }, channels);
    expect(options).toMatchObject({ entityType: GuildScheduledEventEntityType.StageInstance, channel: "11" });
  });

  it("falls back to an External event when the voice channel is unknown, using the name as the location", () => {
    const { options, fellBack } = eventOptions({ ...voice, where: { kind: "voice", channel: "Lounge" } }, channels);
    expect(fellBack).toBe(true);
    expect(options).toMatchObject({
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: "Lounge" },
      scheduledEndTime: new Date("2026-10-23T22:00:00Z"),
    });
    expect(options).not.toHaveProperty("channel");
    // Also when the asker can't see any voice channel.
    expect(eventOptions(voice, []).fellBack).toBe(true);
  });
});

describe("createGuildEvent", () => {
  const guildWith = (create: (o: unknown) => Promise<{ id: string }>) => ({
    id: "g1",
    scheduledEvents: { create },
  });

  it("creates the event and returns its link", async () => {
    const seen: unknown[] = [];
    const guild = guildWith(async (o) => {
      seen.push(o);
      return { id: "e9" };
    });
    const link = await createGuildEvent(guild, external, channels, () => {}, "asked by amy");
    expect(link).toBe("https://discord.com/events/g1/e9");
    expect(seen[0]).toMatchObject({ name: "Raid night", reason: "asked by amy" });
  });

  it("never throws: a refusal is logged and returns null", async () => {
    const logs: string[] = [];
    const guild = guildWith(async () => {
      throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
    });
    expect(await createGuildEvent(guild, external, channels, (l) => logs.push(l))).toBeNull();
    expect(logs.join(" ")).toMatch(/event failed/);
    expect(logs.join(" ")).toContain("50013");
  });
});
