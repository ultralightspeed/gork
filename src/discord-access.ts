// Reads from a Discord message what the asker and gork may do, who may be tagged, and which images to look at.
import type { GuildMember, Message } from "discord.js";
import { pickImageUrls } from "./images.ts";
import { buildPingContext, type MentionKind, type PingContext } from "./mentions.ts";
import { imageSources } from "./message.ts";
import { canCreateEvents, channelAbilities, type Permission } from "./permissions.ts";

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

/** Up to 3 images, the asker's own first; the replied-to message's are kept apart for the strike check. */
export function splitImageUrls(message: Message, ref: Message | null) {
  const imageUrls = pickImageUrls(imageSources(message), 3);
  const replyImageUrls = ref ? pickImageUrls(imageSources(ref), 3 - imageUrls.length) : [];
  return { imageUrls, replyImageUrls };
}
