// Posts gork's outcome to Discord: the reply text and files, the poll, the event link or change, and the typing
// indicator.
import { ChannelType, type Message, MessageFlags } from "discord.js";
import { eventAccess } from "./discord-access.ts";
import { changeGuildEvent, createGuildEvent } from "./discord-event.ts";
import { describeError } from "./errors.ts";
import { deletedNote, type EventChange, type ScheduledEvent, type VoiceChannelRef } from "./event.ts";
import { hidesPreviews, type LinkSet } from "./links.ts";
import { type AllowedMentions, defuseEveryone, NO_PINGS, type Pinged } from "./mentions.ts";
import { canHoldEvent } from "./permissions.ts";
import { type Poll, toDiscordPoll } from "./poll.ts";
import { splitMessage } from "./split.ts";
import type { Attachment } from "./tools.ts";

export type ReplyPayload = {
  content: string;
  allowedMentions: AllowedMentions;
  files?: { attachment: Buffer; name: string }[];
  flags?: MessageFlags.SuppressEmbeds;
};
/** The part of a Discord message the sender uses; discord.js's Message satisfies it. */
export type Replyable = { reply(payload: ReplyPayload): Promise<Replyable> };

type ReplyContent = {
  text: string;
  files: Attachment[];
  /** Links the asker gave; a chunk with any other link goes out without previews. */
  given: LinkSet;
  /** Adds the pings to the first chunk. Later chunks never ping. */
  ping: (first: string) => Pinged;
  /** False when the asker can't embed links: then no chunk shows previews. */
  previews?: boolean;
};

/**
 * Posts the reply in chunks, each replying to the one before. Logs a failed send instead of throwing. Returns whether
 * the reply went out: its first message was posted.
 */
export async function sendReply(
  message: Replyable,
  reply: ReplyContent,
  log: (line: string) => void,
): Promise<boolean> {
  const flags = (content: string) =>
    reply.previews === false || hidesPreviews(content, reply.given)
      ? ({ flags: MessageFlags.SuppressEmbeds } as const)
      : {};
  let posted = false;
  try {
    const chunks = splitMessage(reply.text);
    const first = reply.ping(chunks[0]);
    let last = await message.reply({
      content: first.text,
      allowedMentions: first.allowedMentions,
      files: reply.files.map((f) => ({ attachment: f.data, name: f.name })),
      ...flags(first.text),
    });
    posted = true;
    for (const c of chunks.slice(1)) {
      const content = defuseEveryone(c);
      last = await last.reply({ content, allowedMentions: NO_PINGS, ...flags(content) });
    }
  } catch (err) {
    log(`send failed: ${describeError(err)}`);
  }
  return posted;
}

export async function postPoll(message: Message, poll: Poll, log: (line: string) => void): Promise<boolean> {
  try {
    await message.reply({ poll: toDiscordPoll(poll), allowedMentions: NO_PINGS });
    return true;
  } catch (err) {
    log(`poll failed: ${describeError(err)}`);
    return false;
  }
}

/** The voice and Stage channels both the asker and gork can hold a new event in, with each channel's overrides. */
function holdableChannels(message: Message): VoiceChannelRef[] {
  const me = message.guild?.members.me;
  const asker = message.member;
  return [...(message.guild?.channels.cache.values() ?? [])]
    .filter(
      (ch) =>
        ch.isVoiceBased() &&
        [me, asker].every(
          (m) =>
            !!m && canHoldEvent((perm) => !!ch.permissionsFor(m)?.has(perm), ch.type === ChannelType.GuildStageVoice),
        ),
    )
    .map((ch) => ({ id: ch.id, name: ch.name, stage: ch.type === ChannelType.GuildStageVoice }));
}

/** Posts a short note after the reply; logs a failed send instead of throwing. */
async function postNote(message: Message, content: string, log: (line: string) => void): Promise<void> {
  try {
    await message.reply({ content, allowedMentions: NO_PINGS });
  } catch (err) {
    log(`event reply failed: ${describeError(err)}`);
  }
}

/**
 * Creates the event and posts its link, or `failed` when Discord refused. Voice channels are limited to ones both
 * the asker and gork can hold an event in.
 */
export async function postEvent(
  message: Message,
  ev: ScheduledEvent,
  failed: string,
  log: (line: string) => void,
): Promise<void> {
  const guild = message.guild;
  if (!guild) return;
  const link = await createGuildEvent(
    guild,
    ev,
    holdableChannels(message),
    log,
    `Created by gork for ${message.author.username}`,
  );
  await postNote(message, link ?? failed, log);
}

/**
 * Makes the edit or deletion the reply announced, then posts the event's link after an edit, or a note naming the
 * event after a deletion; `failed.edit` or `failed.delete` when it couldn't be made.
 */
export async function postEventChange(
  message: Message,
  change: EventChange,
  failed: { edit: string; delete: string },
  log: (line: string) => void,
): Promise<void> {
  const guild = message.guild;
  const access = eventAccess(message);
  if (!guild || !access) return;
  const asker = {
    reason: `Changed by gork for ${message.author.username}`,
    who: `${message.author.username}(${message.author.id})`,
  };
  const done = await changeGuildEvent(guild, access, change, log, asker);
  const posted = change.kind === "edit" ? change.event.link : deletedNote(change.event);
  await postNote(message, done ? posted : failed[change.kind], log);
}

/** Shows "gork is typing" until the returned function is called. */
export function startTyping(message: Message): () => void {
  const ch = message.channel;
  if (!ch.isSendable()) return () => {};
  const tick = () => {
    ch.sendTyping().catch(() => {});
  };
  tick();
  const t = setInterval(tick, 8000);
  return () => clearInterval(t);
}
