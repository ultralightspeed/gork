// Step 2 of setup: the bot token, Message Content, Public Bot, and the server gork answers in.
import {
  DiscordTokenRejectedError,
  enableMessageContent,
  type Guild,
  GuildsRefusedError,
  getApplication,
  listGuilds,
  looksLikeBotToken,
  RateLimitedError,
} from "./discord-setup.ts";
import { CliError } from "./errors.ts";
import type { SessionCore } from "./setup-core.ts";
import { DISCORD_GAP_MS, fresh, text, type View } from "./setup-state.ts";
import { printable } from "./text.ts";

export async function discordToken(core: SessionCore, raw: unknown): Promise<View> {
  core.requireChoices();
  if (core.cf.token) throw new CliError("Discord is done: Cloudflare setup has already started.");
  const token = text(raw) ?? "";
  if (!token) throw new CliError("Paste the bot token into the box first.");
  if (!looksLikeBotToken(token)) {
    throw new CliError(
      "That doesn't look like a Discord bot token (a bot token has two dots, like xxxx.yyyy.zzzz). On the Bot page click Reset Token and copy the token it shows; the Client Secret and a Cloudflare token won't work.",
    );
  }
  core.begin("discord", ["Asking Discord about the bot", "Turning on Message Content"]);
  const app = await getApplication(token, core.deps.fetch);
  core.discord = { ...fresh.discord(), token, app, appName: printable(app.name) };
  core.reach(1);
  try {
    const how = await enableMessageContent(token, app, core.deps.fetch);
    core.discord.intent = { ok: true, message: `Message Content is ${how}.` };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    core.discord.intent = {
      ok: false,
      message: `${err.message} Setup can go on, but gork can't read messages until it is on.`,
    };
  }
  core.discord.publicBot = app.bot_public ? "on" : "off";
  return core.view();
}

/**
 * One look at Discord, called by the page every few seconds: has the bot joined a server, and (while it is on) has
 * Public Bot been turned off? Asks Discord at most every couple of seconds.
 */
export async function discordRefresh(core: SessionCore): Promise<View> {
  const app = core.requireApp();
  const d = core.discord;
  const now = core.deps.now();
  if (now < d.notBefore || now - d.lastPoll < DISCORD_GAP_MS) return core.view();
  d.lastPoll = now;
  try {
    if (d.publicBot === "on") {
      const current = await getApplication(d.token, core.deps.fetch);
      if (current.id === app.id && !current.bot_public) d.publicBot = "off";
    }
    if (!d.guildsProblem) {
      d.guilds = (await listGuilds(d.token, core.deps.fetch)).map((g: Guild) => ({
        id: g.id,
        name: printable(g.name),
      }));
    }
    d.problem = null;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (err instanceof DiscordTokenRejectedError && !core.cf.token) {
      // The token stopped working: back to asking for one, with the reason.
      core.discord = { ...fresh.discord(), problem: err.message };
    } else if (err instanceof GuildsRefusedError) {
      d.guildsProblem = err.message;
    } else if (err instanceof RateLimitedError) {
      d.notBefore = now + Math.max(err.retryAfterMs, DISCORD_GAP_MS);
      d.problem = err.message;
    } else {
      d.problem = err.message;
    }
  }
  return core.view();
}

/** The servers gork should answer in: ones the bot was seen in, or (when Discord won't say) one pasted server ID. */
export async function confirmServers(core: SessionCore, ids: unknown, manualId?: unknown): Promise<View> {
  core.requireApp();
  const d = core.discord;
  const wanted = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  const picked: { id: string; name: string }[] = [];
  for (const id of [...new Set(wanted)]) {
    const g = d.guilds?.find((x) => x.id === id);
    if (!g) throw new CliError("That isn't a server gork was added to. Pick one from the list.");
    picked.push({ ...g });
  }
  const manual = text(manualId);
  if (manual) {
    if (!/^\d{1,25}$/.test(manual)) throw new CliError("A server ID is digits only, like 123456789012345678.");
    if (!picked.some((g) => g.id === manual)) picked.push({ id: manual, name: "" });
  }
  if (picked.length === 0) throw new CliError("Pick the server (or servers) gork should answer in.");
  d.selected = picked;
  return core.view();
}
