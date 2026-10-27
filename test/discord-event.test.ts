import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, GuildScheduledEventStatus } from "discord.js";
import { describe, expect, it } from "vitest";
import type { EventAccess } from "../src/discord-access.ts";
import {
  changeGuildEvent,
  createGuildEvent,
  type DiscordEvent,
  editOptions,
  eventOptions,
  moveTargets,
  readEvent,
  serverEvents,
} from "../src/discord-event.ts";
import type { EventChange, ScheduledEvent, ServerEvent } from "../src/event.ts";
import type { Permission } from "../src/permissions.ts";

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

/**
 * The asker (u1) and gork (b1). By default the asker has no event permissions and gork has Create Events, and both can
 * see and connect to channels 10 and 12 (voice channels) and 11 (a Stage channel). `hidden` hides channels from one
 * of them; `channel` replaces what one of them has in a channel.
 */
function access(
  o: {
    asker?: Permission[];
    bot?: Permission[];
    hidden?: "asker" | "bot";
    channel?: Record<string, { asker?: Permission[]; bot?: Permission[] }>;
  } = {},
): EventAccess {
  return {
    askerId: "u1",
    botId: "b1",
    has: (who, p, channelId) => {
      const own = channelId === null ? undefined : o.channel?.[channelId]?.[who];
      if (own) return own.includes(p);
      if (channelId !== null && (p === "ViewChannel" || p === "Connect")) return o.hidden !== who;
      return (who === "asker" ? (o.asker ?? []) : (o.bot ?? ["CreateEvents"])).includes(p);
    },
    voiceChannels: () => [
      { id: "10", name: "Raid Voice", stage: false },
      { id: "11", name: "Town Hall", stage: true },
      { id: "12", name: "Staff Voice", stage: false },
    ],
  };
}

/** An event gork made at a location: Friday 2026-10-23, 20:00 to 22:00 UTC. */
const discordEvent = (over: Partial<DiscordEvent> = {}): DiscordEvent => ({
  id: "100",
  name: "Raid night",
  description: "bring flasks",
  scheduledStartTimestamp: Date.parse("2026-10-23T20:00:00Z"),
  scheduledEndTimestamp: Date.parse("2026-10-23T22:00:00Z"),
  status: GuildScheduledEventStatus.Scheduled,
  channelId: null,
  entityMetadata: { location: "Ironforge" },
  creatorId: "b1",
  userCount: 3,
  recurrenceRule: null,
  ...over,
});

/** discordEvent() as readEvent gives it to an asker who may have it changed. */
const raid: ServerEvent = {
  id: "100",
  name: "Raid night",
  start: new Date("2026-10-23T20:00:00Z"),
  end: new Date("2026-10-23T22:00:00Z"),
  where: { kind: "location", text: "Ironforge" },
  description: "bring flasks",
  live: false,
  interested: 3,
  madeBy: "gork",
  repeats: false,
  link: "https://discord.com/events/1/100",
  cantChange: null,
};

describe("readEvent", () => {
  const moderator = access({ asker: ["ManageEvents"] });

  it("reads an event at a location, with its link", () => {
    expect(readEvent(discordEvent(), moderator, "1")).toEqual(raid);
  });

  it("reads an event in a voice channel by the channel's name, when the asker and gork can both see it", () => {
    const inVoice = discordEvent({ channelId: "10", entityMetadata: null, scheduledEndTimestamp: null });
    expect(readEvent(inVoice, moderator, "1")).toMatchObject({
      where: { kind: "voice", channel: "Raid Voice" },
      end: null,
    });
    expect(readEvent(inVoice, access({ asker: ["ManageEvents"], hidden: "asker" }), "1")).toBeNull();
    expect(readEvent(inVoice, access({ asker: ["ManageEvents"], hidden: "bot" }), "1")).toBeNull();
    expect(readEvent(discordEvent({ channelId: "99", entityMetadata: null }), moderator, "1")).toBeNull();
  });

  it("keeps events still to come or under way, and leaves out ones that are over or canceled", () => {
    expect(readEvent(discordEvent({ status: GuildScheduledEventStatus.Active }), moderator, "1")?.live).toBe(true);
    for (const status of [GuildScheduledEventStatus.Completed, GuildScheduledEventStatus.Canceled]) {
      expect(readEvent(discordEvent({ status }), moderator, "1"), String(status)).toBeNull();
    }
  });

  it("says who made it and whether it repeats", () => {
    const madeBy = (creatorId: string | null) => readEvent(discordEvent({ creatorId }), moderator, "1")?.madeBy;
    expect([madeBy("b1"), madeBy("u1"), madeBy("u2"), madeBy(null)]).toEqual(["gork", "asker", "other", "other"]);
    expect(readEvent(discordEvent({ recurrenceRule: {} }), moderator, "1")?.repeats).toBe(true);
  });

  it("says why it can't be changed, checking the asker and then gork", () => {
    // The asker without Manage Events can't change gork's event, though gork made it for them.
    expect(readEvent(discordEvent(), access(), "1")?.cantChange).toMatch(/counts it as yours/);
    // gork with Create Events alone can't change someone else's event.
    const theirs = discordEvent({ creatorId: "u2" });
    expect(readEvent(theirs, moderator, "1")?.cantChange).toMatch(/you can change only events you made/);
    expect(readEvent(theirs, access({ asker: ["ManageEvents"], bot: ["ManageEvents"] }), "1")?.cantChange).toBeNull();
    // An asker with Create Events may change their own event.
    const own = discordEvent({ creatorId: "u1" });
    expect(readEvent(own, access({ asker: ["CreateEvents"], bot: ["ManageEvents"] }), "1")?.cantChange).toBeNull();
    // A Stage event needs the Stage permissions too, which gork's invite doesn't ask for: the asker's are checked first.
    const onStage = discordEvent({ channelId: "11", entityMetadata: null });
    expect(readEvent(onStage, moderator, "1")?.cantChange).toMatch(/Stage channel, and the person asking doesn't/);
    const stagehand = access({ asker: ["ManageEvents", "ManageChannels", "MuteMembers", "MoveMembers"] });
    expect(readEvent(onStage, stagehand, "1")?.cantChange).toMatch(/Stage channel, and you don't have/);
  });

  it("drops invisible characters from the text members wrote", () => {
    const sneaky = discordEvent({ name: "Ra​id", description: "b​ring", entityMetadata: { location: "I​f" } });
    expect(readEvent(sneaky, moderator, "1")).toMatchObject({
      name: "Raid",
      description: "bring",
      where: { kind: "location", text: "If" },
    });
  });
});

describe("serverEvents", () => {
  it("lists the events the asker can see, soonest first, asking Discord afresh each time", async () => {
    let fetches = 0;
    const later = discordEvent({ id: "101", scheduledStartTimestamp: Date.parse("2026-10-30T20:00:00Z") });
    const hidden = discordEvent({ id: "102", channelId: "99" });
    const guild = {
      id: "1",
      scheduledEvents: {
        fetch: async () => {
          fetches++;
          return new Map([later, hidden, discordEvent()].map((e) => [e.id, e]));
        },
      },
    };
    const events = serverEvents(guild, access());
    expect(events.guildId).toBe("1");
    expect((await events.list()).map((e) => e.id)).toEqual(["100", "101"]);
    await events.list();
    expect(fetches).toBe(2);
    expect(events.channelsFor(raid).map((c) => c.id)).toEqual(moveTargets(raid, access()).map((c) => c.id));
  });
});

describe("moveTargets", () => {
  it("offers the voice and Stage channels where both the asker and gork may change the event", () => {
    // gork made it, so its Create Events is enough; the asker needs Manage Events. Neither has the Stage permissions.
    expect(moveTargets(raid, access({ asker: ["ManageEvents"] })).map((c) => c.id)).toEqual(["10", "12"]);
    expect(moveTargets(raid, access())).toEqual([]);
  });

  it("checks the event permissions in each channel, so a channel's own overrides count", () => {
    const deniedThere = access({ asker: ["ManageEvents"], channel: { "10": { asker: ["ViewChannel", "Connect"] } } });
    expect(moveTargets(raid, deniedThere).map((c) => c.id)).toEqual(["12"]);
  });
});

describe("editOptions", () => {
  const channels = [
    { id: "10", name: "Raid Voice", stage: false },
    { id: "11", name: "Town Hall", stage: true },
  ];

  it("sends only what changes, moving the end with the start", () => {
    expect(editOptions(raid, { name: "Raid night 2", description: "bring food" }, channels)).toEqual({
      name: "Raid night 2",
      description: "bring food",
    });
    expect(editOptions(raid, { start: new Date("2026-10-24T21:00:00Z") }, channels)).toEqual({
      scheduledStartTime: new Date("2026-10-24T21:00:00Z"),
      scheduledEndTime: new Date("2026-10-24T23:00:00Z"),
    });
  });

  it("makes an event moved to a location an External event, with an end", () => {
    const inVoice: ServerEvent = { ...raid, where: { kind: "voice", channel: "Raid Voice" }, end: null };
    expect(editOptions(inVoice, { where: { kind: "location", text: "Orgrimmar" } }, channels)).toEqual({
      entityType: GuildScheduledEventEntityType.External,
      channel: null,
      entityMetadata: { location: "Orgrimmar" },
      scheduledEndTime: new Date("2026-10-23T22:00:00Z"),
    });
  });

  it("moves an event to a voice or Stage channel found by name, and to nowhere else", () => {
    expect(editOptions(raid, { where: { kind: "voice", channel: "raid voice" } }, channels)).toEqual({
      entityType: GuildScheduledEventEntityType.Voice,
      channel: "10",
    });
    expect(editOptions(raid, { where: { kind: "voice", channel: "Town Hall" } }, channels)).toMatchObject({
      entityType: GuildScheduledEventEntityType.StageInstance,
      channel: "11",
    });
    // No location of that name instead, as for a new event: that could show the event to everyone.
    expect(editOptions(raid, { where: { kind: "voice", channel: "Lounge" } }, channels)).toBeNull();
  });

  it("leaves an event in voice chat without an end when it had none", () => {
    const inVoice: ServerEvent = { ...raid, where: { kind: "voice", channel: "Raid Voice" }, end: null };
    expect(editOptions(inVoice, { start: new Date("2026-10-24T21:00:00Z") }, channels)).toEqual({
      scheduledStartTime: new Date("2026-10-24T21:00:00Z"),
    });
  });
});

describe("changeGuildEvent", () => {
  type Calls = { fetches: number; edited: unknown[]; deleted: string[] };
  /** A server whose only event is `event` (none for null); `fail` is what Discord answers an edit or deletion with. */
  const guildWith = (event: DiscordEvent | null | Error, calls: Calls, fail?: Error) => ({
    id: "1",
    scheduledEvents: {
      fetch: async () => {
        calls.fetches++;
        if (event instanceof Error) throw event;
        return new Map(event ? [[event.id, event]] : []);
      },
      edit: async (id: string, options: unknown) => {
        if (fail) throw fail;
        calls.edited.push([id, options]);
        return {};
      },
      delete: async (id: string) => {
        if (fail) throw fail;
        calls.deleted.push(id);
      },
    },
  });
  const moderator = access({ asker: ["ManageEvents"] });
  const rename: EventChange = { kind: "edit", event: raid, edit: { name: "Raid night 2" } };
  const remove: EventChange = { kind: "delete", event: raid };
  const asker = { reason: "for amy", who: "amy(u1)" };
  const fresh = (): Calls => ({ fetches: 0, edited: [], deleted: [] });
  const change = async (event: DiscordEvent | null | Error, who: EventAccess, what: EventChange, fail?: Error) => {
    const calls = fresh();
    const logs: string[] = [];
    const ok = await changeGuildEvent(guildWith(event, calls, fail), who, what, (l) => logs.push(l), asker);
    return { ok, calls, logs };
  };

  it("reads the event afresh from Discord, then edits it with the audit-log reason, logging who asked", async () => {
    const { ok, calls, logs } = await change(discordEvent(), moderator, rename);
    expect(ok).toBe(true);
    expect(calls.fetches).toBe(1);
    expect(calls.edited).toEqual([["100", { name: "Raid night 2", reason: "for amy" }]]);
    expect(logs).toEqual(["event 100 changed for amy(u1)"]);
  });

  it("deletes it, logging which one and who asked, since Discord's audit log can't say who", async () => {
    const { ok, calls, logs } = await change(discordEvent(), moderator, remove);
    expect(ok).toBe(true);
    expect(calls.deleted).toEqual(["100"]);
    expect(logs).toEqual(["event 100 deleted for amy(u1)"]);
  });

  it("makes no edit or deletion when the event is gone, over or canceled, or no longer the asker's to change", async () => {
    const cases: [DiscordEvent | null | Error, EventAccess][] = [
      [null, moderator],
      [Object.assign(new Error("Service Unavailable"), { status: 503 }), moderator],
      [discordEvent({ status: GuildScheduledEventStatus.Canceled }), moderator],
      [discordEvent(), access()],
    ];
    for (const what of [rename, remove]) {
      for (const [event, who] of cases) {
        const { ok, calls, logs } = await change(event, who, what);
        expect(ok, `${what.kind} ${String(event)}`).toBe(false);
        expect(calls.edited.length + calls.deleted.length).toBe(0);
        expect(logs.join(" ")).toMatch(/event change/);
      }
    }
  });

  it("deletes an event that is under way, but won't edit one", async () => {
    const live = discordEvent({ status: GuildScheduledEventStatus.Active });
    expect((await change(live, moderator, rename)).ok).toBe(false);
    expect((await change(live, moderator, remove)).calls.deleted).toEqual(["100"]);
  });

  it("moves an event only to a voice channel both may still change it in", async () => {
    const toRaidVoice: EventChange = {
      kind: "edit",
      event: raid,
      edit: { where: { kind: "voice", channel: "Raid Voice" } },
    };
    expect((await change(discordEvent(), moderator, toRaidVoice)).calls.edited).toEqual([
      ["100", { entityType: GuildScheduledEventEntityType.Voice, channel: "10", reason: "for amy" }],
    ]);
    // The asker lost Connect in Raid Voice since the reply: the channels are worked out again.
    const lost = access({ asker: ["ManageEvents"], channel: { "10": { asker: ["ViewChannel", "ManageEvents"] } } });
    expect((await change(discordEvent(), lost, toRaidVoice)).ok).toBe(false);
  });

  it("never throws: Discord's refusal is logged and returns false", async () => {
    const refusal = Object.assign(new Error("Missing Permissions"), { code: 50013 });
    const { ok, logs } = await change(discordEvent(), moderator, rename, refusal);
    expect(ok).toBe(false);
    expect(logs.join(" ")).toMatch(/event change failed.*50013/);
  });
});
