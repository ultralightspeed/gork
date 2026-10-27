// Reads from a Discord message what the asker and gork may do and who may be tagged, and picks the images to attach.
import { ChannelType, type GuildMember, type Message } from "discord.js";
import type { Msg } from "./context.ts";
import type { VoiceChannelRef } from "./event.ts";
import { buildPingContext, type MentionKind, type PingContext } from "./mentions.ts";
import { canCreateEvents, channelAbilities, type EventChangeBlock, type Permission } from "./permissions.ts";

export const botRoleId = (m: Message): string | null => m.guild?.members.me?.roles.botRole?.id ?? null;

/** What gork may do in the message's channel for its author; an author who isn't a member may do nothing. */
export function abilities(message: Message) {
  const ch = message.channel;
  const has = (m: GuildMember | null | undefined) => (perm: Permission) =>
    !!m && ch.isTextBased() && "permissionsFor" in ch && !!ch.permissionsFor(m)?.has(perm);
  return channelAbilities(has(message.guild?.members.me), has(message.member), ch.isThread());
}

/** Whether the asker could ping @everyone in this channel themselves (threads use their parent's permissions). */
export function askerCanMentionEveryone(message: Message): boolean {
  const ch = message.channel;
  return !!message.member && "permissionsFor" in ch && !!ch.permissionsFor(message.member)?.has("MentionEveryone");
}

const refused = (what: string, why: string) =>
  `You can't ${what} for this request: ${why} Tell them briefly, and don't say it was done.`;

/**
 * Null when gork may create an event for this asker: both the asker and gork have Create Events on the server.
 * Otherwise what the model is told, naming the one reason that applies. No wording check: an event is visible, one
 * per reply, screened and deletable, and the asker could have made it themselves.
 */
export function eventRefusal(message: Message): string | null {
  const may = (m: GuildMember | null | undefined) => !!m && canCreateEvents((perm) => m.permissions.has(perm));
  if (!may(message.member))
    return refused("create an event", "the person asking doesn't have the Create Events permission on this server.");
  if (!may(message.guild?.members.me))
    return refused(
      "create an event",
      "you don't have the Create Events permission on this server; a server admin can give your role Create Events.",
    );
  return null;
}

/** The asker's and gork's permissions as the event tools read them, so the event code can be tested without Discord. */
export type EventAccess = {
  askerId: string;
  botId: string;
  /** Whether the asker or gork has a permission in a channel (its overrides count), or on the server for null. */
  has: (who: "asker" | "bot", permission: Permission, channelId: string | null) => boolean;
  /** The server's voice and Stage channels. */
  voiceChannels: () => VoiceChannelRef[];
};

/** The event permissions of the message's author and gork; null outside a server. */
export function eventAccess(message: Message): EventAccess | null {
  const guild = message.guild;
  const asker = message.member;
  const me = guild?.members.me;
  if (!guild || !asker || !me) return null;
  return {
    askerId: asker.id,
    botId: me.id,
    has: (who, permission, channelId) => {
      const m = who === "asker" ? asker : me;
      if (channelId === null) return m.permissions.has(permission);
      return !!guild.channels.cache.get(channelId)?.permissionsFor(m)?.has(permission);
    },
    voiceChannels: () =>
      [...guild.channels.cache.values()].flatMap((ch) =>
        ch.isVoiceBased() ? [{ id: ch.id, name: ch.name, stage: ch.type === ChannelType.GuildStageVoice }] : [],
      ),
  };
}

const NO_STAGE = "Manage Channels, Mute Members and Move Members";

/**
 * Why gork can't change or delete an event for this asker, naming the first thing in the way, or null when nothing
 * is. `asker` and `bot` are what eventChangeBlock found for each; the text is told to the model, so gork is "you".
 */
export function eventChangeWhyNot(
  asker: EventChangeBlock,
  bot: EventChangeBlock,
  { madeBy, stage }: { madeBy: "gork" | "asker" | "other"; stage: boolean },
): string | null {
  if (asker === "manage") {
    const whose = madeBy === "gork" ? "you made it, and Discord counts it as yours" : "someone else made it";
    return `${whose}, so changing it needs the Manage Events permission, which the person asking doesn't have.`;
  }
  if (asker === "create") return "the person asking doesn't have the Create Events or Manage Events permission.";
  if (asker === "channel") {
    return stage
      ? `it's in a Stage channel, and the person asking doesn't have ${NO_STAGE} there.`
      : "it's in a voice channel the person asking can't connect to.";
  }
  if (bot === "manage") return "you can change only events you made; a server admin can give your role Manage Events.";
  if (bot === "create") {
    return "you don't have the Create Events permission on this server; a server admin can give your role Create Events.";
  }
  if (bot === "channel") {
    return stage
      ? `it's in a Stage channel, and you don't have ${NO_STAGE} there; a server admin can give your role them.`
      : "it's in a voice channel you can't connect to.";
  }
  return null;
}

/** Null when gork may post a poll here (both it and the asker may post polls); otherwise what the model is told. */
export const pollRefusal = (can: { poll: boolean }): string | null =>
  can.poll ? null : refused("post a poll", "you or the person asking may not post polls in this channel.");

/** Reads the people and roles off the Discord messages; mentions.ts decides who may be tagged. */
export function pingContext(
  message: Message,
  others: Message[],
  o: { botId: string | undefined; allowed: Set<MentionKind>; everyoneRequested: boolean },
): PingContext {
  const authors = [message, ...others]
    .filter((m) => !m.author.bot)
    .map((m) => ({ id: m.author.id, names: [m.member?.displayName, m.author.displayName, m.author.username] }));
  const mentioned = [...message.mentions.users]
    .filter(([, u]) => !u.bot)
    .map(([id, u]) => ({
      id,
      names: [message.mentions.members?.get(id)?.displayName, u.displayName, u.username],
    }));
  return buildPingContext({
    botId: o.botId,
    people: [...authors, ...mentioned],
    roles: [...(message.guild?.roles.cache.values() ?? [])],
    guildId: message.guild?.id,
    allowed: o.allowed,
    askerCanMentionEveryone: askerCanMentionEveryone(message),
    everyoneRequested: o.everyoneRequested,
  });
}

/** Most images attached to a request, the asker's own and the replied-to message's together. */
const MAX_ATTACHED_IMAGES = 3;

/** The images to attach, the asker's own first; the replied-to message's are kept apart for the strike check. */
export function splitImageUrls(question: Msg, replyTo: Msg | null) {
  const imageUrls = question.images.slice(0, MAX_ATTACHED_IMAGES);
  const replyImageUrls = replyTo ? replyTo.images.slice(0, MAX_ATTACHED_IMAGES - imageUrls.length) : [];
  return { imageUrls, replyImageUrls };
}
