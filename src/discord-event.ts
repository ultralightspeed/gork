// The Discord side of the event tools: reads the server's events for an asker, and turns a validated new event or
// change into the API call.
import {
  type GuildScheduledEventCreateOptions,
  type GuildScheduledEventEditOptions,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
} from "discord.js";
import { stripInvisible } from "./context.ts";
import { type EventAccess, eventChangeWhyNot } from "./discord-access.ts";
import { describeError } from "./errors.ts";
import {
  type EventChange,
  type EventEdit,
  editedTimes,
  externalEnd,
  pickVoiceChannel,
  type ScheduledEvent,
  type ServerEvent,
  type ServerEvents,
  type VoiceChannelRef,
} from "./event.ts";
import { type EventChangeBlock, eventChangeBlock } from "./permissions.ts";

/** The link that opens an event in Discord. */
const eventLink = (guildId: string, eventId: string): string => `https://discord.com/events/${guildId}/${eventId}`;

/**
 * The API options for an event, visible to the server only. A location is an External event (which must have an
 * end); a voice or Stage channel is found by name among `channels`, and a name that isn't there becomes an External
 * event with that name as its location, so nothing is revealed about channels the asker can't see.
 */
export function eventOptions(
  ev: ScheduledEvent,
  channels: VoiceChannelRef[],
): { options: GuildScheduledEventCreateOptions; fellBack: boolean } {
  const base = {
    name: ev.name,
    scheduledStartTime: ev.start,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    ...(ev.description ? { description: ev.description } : {}),
  };
  if (ev.where.kind === "voice") {
    const channel = pickVoiceChannel(ev.where.channel, channels);
    if (channel) {
      return {
        fellBack: false,
        options: {
          ...base,
          entityType: channel.stage ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice,
          channel: channel.id,
          ...(ev.end ? { scheduledEndTime: ev.end } : {}),
        },
      };
    }
  }
  const location = ev.where.kind === "voice" ? ev.where.channel : ev.where.text;
  return {
    fellBack: ev.where.kind === "voice",
    options: {
      ...base,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location },
      scheduledEndTime: externalEnd(ev),
    },
  };
}

/** The part of a Discord guild createGuildEvent needs, so tests can stand in for it. */
type CreateGuild = {
  id: string;
  scheduledEvents: { create(options: GuildScheduledEventCreateOptions): Promise<{ id: string }> };
};

/** Creates the event. Returns its link, or null after logging why not. Never throws. */
export async function createGuildEvent(
  guild: CreateGuild,
  ev: ScheduledEvent,
  channels: VoiceChannelRef[],
  log: (line: string) => void,
  /** Shown in the server's audit log next to the event. */
  reason?: string,
): Promise<string | null> {
  try {
    const { options, fellBack } = eventOptions(ev, channels);
    if (fellBack) log("event: voice channel not found or not usable by the asker; used its name as the location");
    const created = await guild.scheduledEvents.create(reason ? { ...options, reason } : options);
    return eventLink(guild.id, created.id);
  } catch (err) {
    log(`event failed: ${describeError(err)}`);
    return null;
  }
}

/** The parts of a Discord scheduled event the event tools read; discord.js's GuildScheduledEvent has them. */
export type DiscordEvent = {
  id: string;
  name: string;
  description: string | null;
  scheduledStartTimestamp: number | null;
  scheduledEndTimestamp: number | null;
  status: GuildScheduledEventStatus;
  channelId: string | null;
  entityMetadata: { location: string | null } | null;
  creatorId: string | null;
  userCount: number | null;
  recurrenceRule: object | null;
};

/**
 * An event as the asker can see it, with whether gork may change it for them; null when it is over or canceled, or
 * held in a channel the asker or gork can't see (Discord shows each member only those). Text members wrote is read
 * without invisible characters, like their messages.
 */
export function readEvent(ev: DiscordEvent, access: EventAccess, guildId: string): ServerEvent | null {
  const live = ev.status === GuildScheduledEventStatus.Active;
  if ((!live && ev.status !== GuildScheduledEventStatus.Scheduled) || ev.scheduledStartTimestamp === null) return null;
  const channel = ev.channelId === null ? null : access.voiceChannels().find((c) => c.id === ev.channelId);
  const sees = (who: "asker" | "bot" | "everyone") => access.has(who, "ViewChannel", ev.channelId);
  if (ev.channelId !== null && (!channel || !sees("asker") || !sees("bot"))) return null;
  const madeBy = ev.creatorId === access.botId ? "gork" : ev.creatorId === access.askerId ? "asker" : "other";
  const block = (who: "asker" | "bot") => changeBlock(access, who, madeBy, ev.channelId === null ? null : channel);
  return {
    id: ev.id,
    name: stripInvisible(ev.name),
    start: new Date(ev.scheduledStartTimestamp),
    end: ev.scheduledEndTimestamp === null ? null : new Date(ev.scheduledEndTimestamp),
    where: channel
      ? { kind: "voice", channel: channel.name }
      : { kind: "location", text: stripInvisible(ev.entityMetadata?.location ?? "") },
    description: ev.description ? stripInvisible(ev.description) : null,
    live,
    interested: ev.userCount,
    madeBy,
    repeats: ev.recurrenceRule !== null,
    link: eventLink(guildId, ev.id),
    everyoneSees: !channel || sees("everyone"),
    cantChange: eventChangeWhyNot(block("asker"), block("bot"), { madeBy, stage: !!channel?.stage }),
  };
}

/** What stops the asker or gork changing an event held in `channel` (null: at a location), by Discord's rule. */
function changeBlock(
  access: EventAccess,
  who: "asker" | "bot",
  madeBy: ServerEvent["madeBy"],
  channel: VoiceChannelRef | null | undefined,
): EventChangeBlock {
  return eventChangeBlock((p) => access.has(who, p, channel?.id ?? null), {
    own: madeBy === (who === "bot" ? "gork" : "asker"),
    channel: channel ? (channel.stage ? "stage" : "voice") : "none",
  });
}

/**
 * The voice and Stage channels an event could move to for this asker: those where both the asker and gork may change
 * it, as Discord would ask of them there (each channel's own overrides count).
 */
export function moveTargets(ev: ServerEvent, access: EventAccess): VoiceChannelRef[] {
  return access
    .voiceChannels()
    .filter((ch) => (["asker", "bot"] as const).every((who) => changeBlock(access, who, ev.madeBy, ch) === null));
}

/** The part of a Discord guild serverEvents needs, so tests can stand in for it. */
type ListGuild = { id: string; scheduledEvents: { fetch(): Promise<ReadonlyMap<string, DiscordEvent>> } };

/**
 * The server's events for one asker. Each list() asks Discord again: gork doesn't subscribe to event updates (no
 * Guild Scheduled Events intent), so discord.js's cache would go stale.
 */
export function serverEvents(guild: ListGuild, access: EventAccess): ServerEvents {
  return {
    guildId: guild.id,
    list: async () =>
      [...(await guild.scheduledEvents.fetch()).values()]
        .flatMap((ev) => readEvent(ev, access, guild.id) ?? [])
        .sort((a, b) => a.start.getTime() - b.start.getTime()),
    channelsFor: (ev) => moveTargets(ev, access),
  };
}

type EventEditOptions = GuildScheduledEventEditOptions<
  GuildScheduledEventStatus.Scheduled,
  GuildScheduledEventStatus.Active
>;

/**
 * The API options for an edit, with only what changes; null when it moves the event to a voice channel that isn't
 * among `channels`. A new location makes it an External event, which must have an end. Unlike a new event, a channel
 * name that isn't found never becomes a location: that would show the event to every member.
 */
export function editOptions(ev: ServerEvent, edit: EventEdit, channels: VoiceChannelRef[]): EventEditOptions | null {
  const target = edit.where?.kind === "voice" ? pickVoiceChannel(edit.where.channel, channels) : null;
  if (edit.where?.kind === "voice" && !target) return null;
  const location = edit.where?.kind === "location" ? edit.where.text : null;
  const { start, end } = editedTimes(ev, edit, target ? false : location !== null || ev.where.kind === "location");
  return {
    ...(edit.name ? { name: edit.name } : {}),
    ...(edit.description ? { description: edit.description } : {}),
    ...(edit.start ? { scheduledStartTime: start } : {}),
    ...(end && end.getTime() !== ev.end?.getTime() ? { scheduledEndTime: end } : {}),
    ...(target
      ? {
          entityType: target.stage ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice,
          channel: target.id,
        }
      : {}),
    ...(location !== null && end
      ? {
          entityType: GuildScheduledEventEntityType.External,
          channel: null,
          entityMetadata: { location },
          scheduledEndTime: end,
        }
      : {}),
  };
}

/**
 * Why gork won't make this change to the event as it is now, or null when it may: the rules edit_event and
 * delete_event apply, checked again on the event read afresh.
 */
function changeProblem(ev: ServerEvent, change: EventChange): string | null {
  if (ev.cantChange) return ev.cantChange;
  if (change.kind === "delete") return ev.repeats ? "a repeating event isn't deleted" : null;
  const { start, end, where } = change.edit;
  if (ev.live) return "the event started before it could be changed";
  if (ev.repeats && (start || end || where)) return "only a repeating event's name and description are changed";
  if (where && !ev.everyoneSees) return "an event in a channel not every member can see isn't moved";
  return null;
}

/** The part of a Discord guild changeGuildEvent needs, so tests can stand in for it. */
type ChangeGuild = ListGuild & {
  scheduledEvents: {
    edit(id: string, options: EventEditOptions): Promise<unknown>;
    delete(id: string): Promise<void>;
  };
};

/**
 * Makes the edit or deletion a reply announced, after reading the event afresh (from Discord, not the cache) and
 * checking it again: it must still be there, the asker and gork must still be allowed to change it, and the change must
 * still follow the event tools' rules. A voice channel it moves to must still be one both may change it in. Returns
 * whether it was made, after logging why not. Never throws.
 */
export async function changeGuildEvent(
  guild: ChangeGuild,
  access: EventAccess,
  change: EventChange,
  log: (line: string) => void,
  /** `reason` goes in the server's audit log with an edit (Discord takes none with a deletion); `who` in the log. */
  asker: { reason: string; who: string },
): Promise<boolean> {
  try {
    const found = (await guild.scheduledEvents.fetch()).get(change.event.id);
    const ev = found && readEvent(found, access, guild.id);
    if (!ev) {
      log("event change: the event is gone, over or canceled, or the asker can't see it");
      return false;
    }
    const problem = changeProblem(ev, change);
    if (problem) {
      log(`event change refused: ${problem}`);
      return false;
    }
    if (change.kind === "delete") {
      await guild.scheduledEvents.delete(ev.id);
      log(`event ${ev.id} deleted for ${asker.who}`);
      return true;
    }
    const options = editOptions(ev, change.edit, moveTargets(ev, access));
    if (!options) {
      log("event change: the voice channel is no longer one both the asker and gork may move the event to");
      return false;
    }
    await guild.scheduledEvents.edit(ev.id, { ...options, reason: asker.reason });
    log(`event ${ev.id} changed for ${asker.who}`);
    return true;
  } catch (err) {
    log(`event change failed: ${describeError(err)}`);
    return false;
  }
}
