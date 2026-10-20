import { stripInvisible } from "./context.ts";
import { formatLocalNow, localToUtc } from "./time.ts";

// Discord's own limits for a scheduled event, and the ones gork adds.
export const MAX_NAME = 100;
export const MAX_LOCATION = 100;
export const MAX_DESCRIPTION = 1000;
/** An event can start at most this far ahead. */
export const MAX_DAYS_AHEAD = 365;
/** Discord refuses a start in the past, and a reply can take over a minute before the event is created. */
export const MIN_LEAD_MINUTES = 5;
const MIN_LEAD_MS = MIN_LEAD_MINUTES * 60_000;
/** An External event must have an end; this long after the start when nobody said. */
export const DEFAULT_HOURS = 2;
/** The place of an event when the asker named neither a location nor a voice channel. */
export const DEFAULT_LOCATION = "Discord";
/** The date-time format of `start` and `end`, in the server's time zone. */
export const LOCAL_FORMAT = "YYYY-MM-DDTHH:MM";

type EventPlace = { kind: "location"; text: string } | { kind: "voice"; channel: string };

/** A validated event. `end` is only what was asked for; discord-event.ts applies the default when one is needed. */
export type ScheduledEvent = {
  name: string;
  start: Date;
  end: Date | null;
  where: EventPlace;
  description: string | null;
};

const DAY_MS = 86_400_000;

/** A trimmed string of 1..max characters, null for blank or absent, or an error text. */
function optionalText(value: unknown, key: string, max: number): string | null | { error: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return { error: `${key} must be text of 1-${max} characters.` };
  const text = stripInvisible(value).trim();
  if (!text) return null;
  return text.length > max ? { error: `${key} must be 1-${max} characters.` } : text;
}
const isError = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;

/**
 * Validates model-supplied event arguments, without invisible characters. `start` and `end` are local to `timeZone`.
 * Returns the event, or a reason the model can act on.
 */
export function parseEvent(
  args: Record<string, unknown>,
  { now, timeZone }: { now: Date; timeZone: string },
): ScheduledEvent | string {
  const name = typeof args.name === "string" ? stripInvisible(args.name).trim() : "";
  if (!name || name.length > MAX_NAME) return `name must be 1-${MAX_NAME} characters.`;

  const badTime = (key: string) =>
    `${key} must be a local date-time like 2026-11-06T20:00 (${LOCAL_FORMAT}, in ${timeZone}, no Z or offset); a time the clocks skip over doesn't exist.`;
  const startText = typeof args.start === "string" ? args.start.trim() : "";
  const start = startText ? localToUtc(startText, timeZone) : null;
  if (!start) return badTime("start");
  if (start.getTime() <= now.getTime() + MIN_LEAD_MS) {
    return `start must be at least ${MIN_LEAD_MINUTES} minutes in the future. It is now ${formatLocalNow(now, timeZone)} in ${timeZone}.`;
  }
  if (start.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) {
    return `start must be within the next year. It is now ${formatLocalNow(now, timeZone)} in ${timeZone}.`;
  }

  let end: Date | null = null;
  const endText =
    typeof args.end === "string" ? args.end.trim() : args.end === undefined || args.end === null ? "" : null;
  if (endText === null) return badTime("end");
  if (endText) {
    end = localToUtc(endText, timeZone);
    if (!end) return badTime("end");
    if (end.getTime() <= start.getTime()) return "end must be after start.";
  }

  const location = optionalText(args.location, "location", MAX_LOCATION);
  if (isError(location)) return location.error;
  const voice = optionalText(args.voice_channel, "voice_channel", MAX_LOCATION);
  if (isError(voice)) return voice.error;
  if (location && voice) return "Give only one of location or voice_channel, not both.";

  const description = optionalText(args.description, "description", MAX_DESCRIPTION);
  if (isError(description)) return description.error.replace("must be 1-", "must be at most ");

  const where: EventPlace = voice
    ? { kind: "voice", channel: voice }
    : { kind: "location", text: location ?? DEFAULT_LOCATION };
  return { name, start, end, where, description };
}

/** When an event held at a location ends: the end asked for, else DEFAULT_HOURS after it starts. */
export const externalEnd = (ev: ScheduledEvent): Date =>
  ev.end ?? new Date(ev.start.getTime() + DEFAULT_HOURS * 3_600_000);

/** A voice or Stage channel the event could be held in. */
export type VoiceChannelRef = { id: string; name: string; stage: boolean };

const normalize = (name: string) => name.trim().replace(/^#/, "").trim().toLowerCase();

/** The channel with exactly this name (ignoring case and a leading #), or null if none or several match. */
export function pickVoiceChannel(name: string, channels: VoiceChannelRef[]): VoiceChannelRef | null {
  const wanted = normalize(name);
  if (!wanted) return null;
  const matches = channels.filter((c) => normalize(c.name) === wanted);
  return matches.length === 1 ? matches[0] : null;
}

/** The text of an event the reply screen should read along with the reply. */
export function eventScreenText(ev: ScheduledEvent): string {
  const where = ev.where.kind === "voice" ? ev.where.channel : ev.where.text;
  return `\n\nEvent: ${ev.name}\nWhere: ${where}${ev.description ? `\nDetails: ${ev.description}` : ""}`;
}
