// Which pings gork's replies may carry (the MENTIONS setting). The model writes plain @Name text; this turns
// names of people and roles in the conversation into real pings, within what the setting and the asker allow.

import { neutralize } from "./context.ts";
import { splitCsv } from "./csv.ts";
import { mentionsEveryone } from "./intent.ts";

export const MENTION_KINDS = ["reply", "users", "roles", "everyone"] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

/** Most people and roles one reply may ping, so nobody can make gork ping the whole channel. */
export const MAX_PINGS = 5;

/** "" or "none": no pings; "all": every kind; otherwise a comma list of MENTION_KINDS. */
export function parseMentions(raw: string): Set<MentionKind> {
  const words = splitCsv(raw.toLowerCase());
  if (words.length === 0 || (words.length === 1 && words[0] === "none")) return new Set();
  if (words.length === 1 && words[0] === "all") return new Set(MENTION_KINDS);
  const unknown = words.filter((w) => !(MENTION_KINDS as readonly string[]).includes(w));
  if (unknown.length) {
    throw new Error(
      `has unknown kinds (${unknown.length} not recognized); use some of ${MENTION_KINDS.join(", ")}, all or none`,
    );
  }
  return new Set(words as MentionKind[]);
}

/** Someone or something gork may ping, under every name the chat shows for them. */
type Named = { id: string; names: string[] };

export type PingContext = {
  allowed: Set<MentionKind>;
  /** People in the conversation: the asker, the replied-to author, recent authors, anyone mentioned. */
  people: Named[];
  /** The server's roles; locked (non-mentionable) ones need the asker to hold Mention Everyone. */
  roles: (Named & { mentionable: boolean })[];
  /** Whether the asker has Mention Everyone in this channel. Gork never pings what the asker couldn't. */
  askerCanMentionEveryone: boolean;
  /** The model called ping_everyone for this reply. Without it, @everyone/@here never ping. */
  everyoneRequested: boolean;
};

export type AllowedMentions = { parse: "everyone"[]; users: string[]; roles: string[]; repliedUser: boolean };
export type Pinged = { text: string; allowedMentions: AllowedMentions };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// @everyone/@here as Discord reads them, but not inside an address like bob@here.com.
const EVERYONE = String.raw`(?<![\p{L}\p{N}_])@(everyone|here)\b`;

/** Stops @everyone/@here from pinging or looking like a ping: the word stays, the @ goes ("everyone"). */
export function defuseEveryone(text: string): string {
  return text.replace(new RegExp(EVERYONE, "gu"), "$1");
}

type Target = { mention: string; id: string; kind: "users" | "roles" };

/**
 * Rewrites @Name to Discord mentions and returns the allowedMentions that lets exactly those ping. Anything else
 * (unknown names, raw <@id> the model made up, kinds the setting leaves off) stays inert text.
 */
export function addPings(text: string, ctx: PingContext): Pinged {
  const { allowed } = ctx;
  // name -> target, or null when the name is ambiguous or belongs to something gork may not ping.
  const targets = new Map<string, Target | null>();
  const claim = (names: string[], value: Target | null) => {
    // Match names as the model saw them too (context.ts softens <, > and strips invisible characters).
    for (const name of new Set(names.flatMap((n) => [n, neutralize(n, 40)]))) {
      const key = name.toLowerCase();
      const bare = key.replace(/[^\p{L}\p{N}]/gu, "");
      if ([...key].length < 2 || bare === "everyone" || bare === "here") continue;
      const seen = targets.get(key);
      targets.set(key, value && (seen === undefined || seen?.id === value.id) ? value : null);
    }
  };
  if (allowed.has("users")) {
    for (const p of ctx.people) claim(p.names, { mention: `<@${p.id}>`, id: p.id, kind: "users" });
  }
  for (const r of ctx.roles) {
    const pingable = allowed.has("roles") && (r.mentionable || ctx.askerCanMentionEveryone);
    // A role gork can't ping still claims its name, so a member can't take it by using that nickname.
    claim(r.names, pingable ? { mention: `<@&${r.id}>`, id: r.id, kind: "roles" } : null);
  }

  const users: string[] = [];
  const roles: string[] = [];
  const names = [...targets].filter(([, t]) => t).map(([name]) => name);
  names.sort((a, b) => b.length - a.length);
  let out = text;
  if (names.length) {
    const pattern = new RegExp(
      String.raw`(?<![\p{L}\p{N}_])@(${names.map(escapeRegex).join("|")})(?![\p{L}\p{N}_]|[-.][\p{L}\p{N}])`,
      "giu",
    );
    out = text.replace(pattern, (whole, name: string) => {
      const t = targets.get(name.toLowerCase());
      if (!t) return whole;
      const list = t.kind === "users" ? users : roles;
      if (!list.includes(t.id)) {
        if (users.length + roles.length >= MAX_PINGS) return whole;
        list.push(t.id);
      }
      return t.mention;
    });
  }

  const everyone =
    allowed.has("everyone") &&
    ctx.askerCanMentionEveryone &&
    ctx.everyoneRequested &&
    new RegExp(EVERYONE, "u").test(out);
  if (!everyone) out = defuseEveryone(out);
  return {
    text: out,
    allowedMentions: { parse: everyone ? ["everyone"] : [], users, roles, repliedUser: allowed.has("reply") },
  };
}

/** Discord's limit on one message. */
const MESSAGE_LIMIT = 2000;

/** Allows no pings at all; also the client's default, so nothing pings unless a reply asks for it. */
export const NO_PINGS: AllowedMentions = { parse: [], users: [], roles: [], repliedUser: false };

/**
 * The first chunk of a reply with its pings added. If the pings would push it past `limit`, it goes out without
 * them (and with @everyone defused) rather than failing to send.
 */
export function pingFirstChunk(chunk: string, ctx: PingContext, limit = MESSAGE_LIMIT): Pinged {
  const pinged = addPings(chunk, ctx);
  return pinged.text.length > limit ? { text: defuseEveryone(chunk), allowedMentions: NO_PINGS } : pinged;
}

/**
 * The setting allows @everyone, the asker may use it, and their own message says everyone (or @here, or announce).
 */
export function mayPingEveryone(
  allowed: Set<MentionKind>,
  askerCanMentionEveryone: boolean,
  askerText: string,
): boolean {
  return allowed.has("everyone") && askerCanMentionEveryone && mentionsEveryone(askerText);
}

/** Someone known by name in the conversation, as the adapter reads them from Discord. */
type PersonRef = { id: string; names: (string | null | undefined)[] };
type RoleRef = { id: string; name: string; managed: boolean; mentionable: boolean };

/**
 * Everyone gork may tag (people in the conversation, merged by id, never gork itself) and the server's own roles
 * (not @everyone's role, not bot-managed ones), plus what the asker could ping themselves.
 */
export function buildPingContext(o: {
  botId?: string;
  people: PersonRef[];
  roles: RoleRef[];
  /** The guild's id, which is also the id of its @everyone role. */
  guildId?: string;
  allowed: Set<MentionKind>;
  askerCanMentionEveryone: boolean;
  everyoneRequested: boolean;
}): PingContext {
  const people = new Map<string, Named>();
  for (const { id, names } of o.people) {
    if (id === o.botId) continue;
    const known = people.get(id)?.names ?? [];
    people.set(id, { id, names: [...new Set([...known, ...names.filter((n): n is string => !!n)])] });
  }
  return {
    allowed: o.allowed,
    people: [...people.values()],
    roles: o.roles
      .filter((r) => r.id !== o.guildId && !r.managed)
      .map((r) => ({ id: r.id, names: [r.name], mentionable: r.mentionable })),
    askerCanMentionEveryone: o.askerCanMentionEveryone,
    everyoneRequested: o.everyoneRequested,
  };
}

/** The system-prompt rule matching the setting. The allowedMentions above enforce it either way. */
export function mentionRule(allowed: Set<MentionKind>): string {
  const people = allowed.has("users") || allowed.has("roles");
  const everyone = allowed.has("everyone")
    ? "When the person asking wants everyone pinged, tagged or an announcement made, call ping_everyone every time, even if an earlier reply in the chat said you couldn't: the tool alone decides, and the rules may have changed. If it says yes, start your reply with @everyone (or @here for people online); if it says no, give its reason. Without that call, @everyone and @here won't ping."
    : "never write @everyone or @here.";
  if (!people)
    return allowed.has("everyone")
      ? `Never @mention individuals. ${everyone}`
      : `Never @mention anyone and ${everyone}`;
  const what = [allowed.has("users") && "a person", allowed.has("roles") && "a role"].filter(Boolean).join(" or ");
  return `To tag ${what}, write @ followed by their name exactly as it appears in the chat. Tag only when someone asks you to or it clearly helps, and never tag a list of people. ${allowed.has("everyone") ? everyone : `Otherwise ${everyone}`}`;
}
