// The Discord side of `gork setup` and `gork doctor`: validate the bot token, switch on the Message Content intent,
// build the invite link, and find the server the bot was added to. Every call takes `fetch`, so tests fake it.
// Throws CliError, never prints, and never puts the token in a message.
import { CliError } from "./errors.ts";
import { jsonWithout } from "./text.ts";

const API = "https://discord.com/api/v10";
/** Discord asks bots to identify themselves in the User-Agent. */
const USER_AGENT = "DiscordBot (gork setup, 1)";

/** The Developer Portal's new-application form. */
export const CREATE_APP_URL = "https://discord.com/developers/applications?new_application=true";

/** Application flag: Message Content intent for bots in under 100 servers (the toggle on the Bot page). */
export const MESSAGE_CONTENT_LIMITED = 1 << 19;
/** Application flag: Message Content intent approved for a verified bot. */
export const MESSAGE_CONTENT = 1 << 18;

export type Application = { id: string; name: string; bot_public: boolean; flags: number };
/** A server the bot is in. `permissions` is the bot's server-wide permissions, when Discord says. */
export type Guild = { id: string; name: string; permissions?: bigint };

/** True when either Message Content flag is set; the bot needs the intent or it is disconnected with code 4014. */
export const messageContentOn = (flags: number): boolean => (flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)) !== 0;

const SNOWFLAKE = /^\d{1,25}$/;

/** A bot token is three dot-separated parts (id, timestamp, secret). Checked before anything is sent anywhere. */
export const looksLikeBotToken = (token: string): boolean => /^[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}$/.test(token);

type Reply = { status: number; json: unknown };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

async function call(
  token: string,
  method: string,
  path: string,
  fetchFn: typeof fetch,
  body?: unknown,
): Promise<Reply> {
  let res: Response;
  try {
    res = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": USER_AGENT,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // The underlying error can echo the request; say only what the user can act on.
    throw new CliError("couldn't reach Discord (discord.com). Check your internet connection and try again.");
  }
  return { status: res.status, json: await jsonWithout(res, token) };
}

const ok = (r: Reply) => r.status >= 200 && r.status < 300;

/** Discord says the token is no good (401): asking again with it won't help. */
export class DiscordTokenRejectedError extends CliError {}

/** Discord asked us to slow down (429); `retryAfterMs` is how long it said to wait. */
export class RateLimitedError extends CliError {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("Discord asked setup to slow down (HTTP 429). It looks again in a moment.");
    this.retryAfterMs = retryAfterMs;
  }
}

const slowDown = (r: Reply) =>
  new RateLimitedError(Math.max(0, Math.ceil(Number(obj(r.json).retry_after ?? 0) * 1000)));

/** Validates the token and reads the application it belongs to. */
export async function getApplication(token: string, fetchFn: typeof fetch): Promise<Application> {
  const r = await call(token, "GET", "/applications/@me", fetchFn);
  if (r.status === 429) throw slowDown(r);
  if (r.status === 401) {
    throw new DiscordTokenRejectedError(
      "Discord rejected that bot token (HTTP 401). In the Developer Portal open your app > Bot > Reset Token, copy the new token and paste it again.",
    );
  }
  if (!ok(r)) throw new CliError(`Discord returned HTTP ${r.status} when reading the application`);
  const a = obj(r.json);
  if (typeof a.id !== "string" || !SNOWFLAKE.test(a.id)) {
    throw new CliError("Discord sent an unexpected answer for the application (no valid id)");
  }
  return {
    id: a.id,
    name: typeof a.name === "string" ? a.name : "",
    bot_public: a.bot_public === true,
    flags: typeof a.flags === "number" ? a.flags : 0,
  };
}

/** Where to switch the intent on by hand. */
export const INTENT_STEPS =
  "Developer Portal > your app > Bot page > Privileged Gateway Intents > Message Content Intent, then Save";
const INTENT_HELP = `Turn on Message Content Intent yourself: ${INTENT_STEPS}.`;

/**
 * Switches on the Message Content intent by ORing GATEWAY_MESSAGE_CONTENT_LIMITED into the application flags (what the
 * portal's toggle sets for a bot in fewer than 100 servers), then reads the flags Discord sends back to confirm it.
 */
export async function enableMessageContent(
  token: string,
  app: Application,
  fetchFn: typeof fetch,
): Promise<"already on" | "turned on"> {
  if (messageContentOn(app.flags)) return "already on";
  const r = await call(token, "PATCH", "/applications/@me", fetchFn, { flags: app.flags | MESSAGE_CONTENT_LIMITED });
  if (!ok(r)) throw new CliError(`Discord refused to turn on the intent (HTTP ${r.status}). ${INTENT_HELP}`);
  const after = obj(r.json).flags;
  if (typeof after !== "number" || !messageContentOn(after)) {
    throw new CliError(`Discord accepted the change but the intent is still off. ${INTENT_HELP}`);
  }
  return "turned on";
}

// Permission bits (https://docs.discord.com/developers/topics/permissions), only what gork uses.
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const EMBED_LINKS = 1n << 14n;
const ATTACH_FILES = 1n << 15n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const MENTION_EVERYONE = 1n << 17n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const CREATE_EVENTS = 1n << 44n;
const SEND_POLLS = 1n << 49n;
const ADMINISTRATOR = 1n << 3n;

/** Whether server-wide permissions let the bot create scheduled events (Create Events or Administrator). */
export const canCreateEventsIn = (permissions: bigint): boolean =>
  (permissions & (CREATE_EVENTS | ADMINISTRATOR)) !== 0n;

/**
 * The permissions integer in the invite link: no Administrator, no Manage anything (Create Events lets gork edit or
 * delete only its own events), no Mention Everyone.
 */
export const INVITE_PERMISSIONS =
  VIEW_CHANNEL |
  SEND_MESSAGES |
  EMBED_LINKS |
  ATTACH_FILES |
  READ_MESSAGE_HISTORY |
  SEND_MESSAGES_IN_THREADS |
  CREATE_EVENTS |
  SEND_POLLS;

/** The link that adds the bot to a server. Mention Everyone is requested only when MENTIONS includes everyone. */
export function inviteUrl(appId: string, { mentionEveryone }: { mentionEveryone: boolean }): string {
  if (!SNOWFLAKE.test(appId)) throw new CliError("the application id must be digits only");
  const permissions = mentionEveryone ? INVITE_PERMISSIONS | MENTION_EVERYONE : INVITE_PERMISSIONS;
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${permissions}`;
}

/** Discord won't list the bot's servers (401/403): asking again won't help, so the caller asks for the server ID. */
export class GuildsRefusedError extends CliError {}

const guildsRefused = (status: number) =>
  new GuildsRefusedError(
    `Discord wouldn't list the bot's servers (HTTP ${status}). Add the bot with the invite link, then put the server's ID in GUILD_IDS yourself (Discord > Settings > Advanced > Developer Mode, then right-click the server > Copy Server ID).`,
  );

const toGuilds = (json: unknown): Guild[] =>
  (Array.isArray(json) ? json : [])
    .map(obj)
    .filter((g) => typeof g.id === "string")
    .map((g) => ({
      id: g.id as string,
      name: typeof g.name === "string" ? g.name : "",
      ...(typeof g.permissions === "string" && /^\d{1,20}$/.test(g.permissions)
        ? { permissions: BigInt(g.permissions) }
        : {}),
    }));

/** The servers the bot is in, asked once (an empty list means none). Throws CliError on any refusal or failure. */
export async function listGuilds(token: string, fetchFn: typeof fetch): Promise<Guild[]> {
  const r = await call(token, "GET", "/users/@me/guilds", fetchFn);
  if (r.status === 401 || r.status === 403) throw guildsRefused(r.status);
  if (r.status === 429) throw slowDown(r);
  if (!ok(r)) throw new CliError(`Discord returned HTTP ${r.status} when listing the bot's servers`);
  return toGuilds(r.json);
}

/**
 * Waits for the bot to be added to a server: polls GET /users/@me/guilds until it lists one, or the timeout passes
 * (then returns []). Stops at once on 401/403, since repeated invalid requests get an IP restricted.
 * The docs are silent on whether this endpoint accepts a bot token; a 401/403 here is reported, not retried.
 */
export async function pollGuilds(
  token: string,
  fetchFn: typeof fetch,
  { timeoutMs, intervalMs, sleep }: { timeoutMs: number; intervalMs: number; sleep: (ms: number) => Promise<void> },
): Promise<Guild[]> {
  let waited = 0;
  for (;;) {
    const r = await call(token, "GET", "/users/@me/guilds", fetchFn);
    let pause = intervalMs;
    if (r.status === 401 || r.status === 403) throw guildsRefused(r.status);
    if (r.status === 429) {
      pause = Math.max(intervalMs, Math.ceil(Number(obj(r.json).retry_after ?? 0) * 1000));
    } else if (!ok(r)) {
      throw new CliError(`Discord returned HTTP ${r.status} when listing the bot's servers`);
    } else {
      const guilds = toGuilds(r.json);
      if (guilds.length) return guilds;
    }
    waited += pause;
    if (waited > timeoutMs) return [];
    await sleep(pause);
  }
}
