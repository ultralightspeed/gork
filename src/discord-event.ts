// The Discord side of create_event: turns a validated event into the API call and the link to post.
import {
  type GuildScheduledEventCreateOptions,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
} from "discord.js";
import { describeError } from "./errors.ts";
import { externalEnd, pickVoiceChannel, type ScheduledEvent, type VoiceChannelRef } from "./event.ts";

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

/** The part of a Discord guild this needs, so tests can stand in for it. */
type EventGuild = {
  id: string;
  scheduledEvents: { create(options: GuildScheduledEventCreateOptions): Promise<{ id: string }> };
};

/** Creates the event. Returns its link, or null after logging why not. Never throws. */
export async function createGuildEvent(
  guild: EventGuild,
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
