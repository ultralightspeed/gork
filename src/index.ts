import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client, Events, GatewayIntentBits, type Message, MessageReferenceType } from "discord.js";
import { Budget } from "./budget.ts";
import { type Config, guardNotice, loadConfig } from "./config.ts";
import { shouldTrigger, stripTrigger } from "./context.ts";
import { DailyCounter } from "./dailycounter.ts";
import { utcDay } from "./day.ts";
import {
  abilities,
  askerCanMentionEveryone,
  botRoleId,
  eventRefusal,
  pingContext,
  pollRefusal,
  splitImageUrls,
} from "./discord-access.ts";
import { postEvent, postPoll, sendReply, startTyping } from "./discord-reply.ts";
import { distrustRoots, OLD_NODE_WARNING } from "./distrust.ts";
import { describeError, isFatalCloseCode, isFatalLoginError } from "./errors.ts";
import { caBundle, Gate } from "./ffmpeg.ts";
import { screenFrames, screenImages, screenReply, screenRequest } from "./guard.ts";
import { HEARTBEAT_FILE, startHeartbeat, writeHeartbeat } from "./heartbeat.ts";
import { downloadImages } from "./images.ts";
import { createFatal, createWatchdog } from "./lifecycle.ts";
import { Limits } from "./limits.ts";
import { givenLinks } from "./links.ts";
import { answer } from "./llm.ts";
import { mayPingEveryone, NO_PINGS, pingFirstChunk } from "./mentions.ts";
import { resolveNames, toMsg, videoSources } from "./message.ts";
import { loadPersona, type Persona, SAFETY_REPLIES, systemPrompt } from "./persona.ts";
import { type RespondDeps, respond } from "./respond.ts";
import { describeSearch } from "./search.ts";
import { newToolState, runTool } from "./tools.ts";
import { extractWindow, pickVideos, readVideo } from "./video.ts";
import { VideoWatch } from "./videolook.ts";

const log = (s: string) => console.log(`[gork] ${new Date().toISOString()} ${s}`);
/** Persona presets and your own custom.md; /app/personas in the container. */
const PERSONAS_DIR = join(process.cwd(), "personas");

// discord.js reconnects on its own; if it stays down for 5 minutes, exit so Docker restarts us.
const watchdog = createWatchdog({
  limitMs: 5 * 60_000,
  onExpire: () => {
    log("not connected for 5 minutes; exiting so Docker restarts me");
    process.exit(1);
  },
});
const fatal = createFatal(watchdog);
/** ffmpeg runs one video job at a time, process-wide; this many more may wait before a video is turned away. */
const VIDEO_QUEUE_DEPTH = 2;

async function main(): Promise<void> {
  // Before anything connects: every token gork sends goes over TLS checked against this store.
  const distrusted = distrustRoots();
  log(distrusted === null ? OLD_NODE_WARNING : `trust store: ${distrusted} distrusted root certificate(s) removed`);
  let cfg: Config;
  let budget: Budget;
  try {
    cfg = loadConfig();
  } catch (err) {
    return fatal("config", describeError(err));
  }
  try {
    budget = new Budget(join(cfg.dataDir, "ledger.json"), cfg.limits.dailyBudgetUsd, undefined, log);
  } catch (err) {
    return fatal("data-dir", `can't write the budget ledger in ${cfg.dataDir}: ${describeError(err)}`);
  }
  let persona: Persona;
  try {
    persona = loadPersona(PERSONAS_DIR, cfg.persona);
  } catch (err) {
    return fatal("persona", describeError(err));
  }
  log(guardNotice(cfg.guard.block));
  log(describeSearch(cfg));
  log(`persona: ${persona.source} (${persona.name}), ${persona.body.length} chars`);
  for (const w of persona.warnings) log(`persona warning: ${w}`);
  if (cfg.tools.videosPerDay > 0 && !existsSync(caBundle())) {
    log(`video: no certificate bundle at ${caBundle()}, so videos can't be read (set SSL_CERT_FILE, or run in Docker)`);
  }
  const limits = new Limits(cfg.limits.cooldownSeconds * 1000, cfg.guard.strikeLimit);
  const toolState = newToolState(cfg);
  const videoSlots = new DailyCounter(cfg.tools.videosPerDay);
  const videoGate = new Gate(VIDEO_QUEUE_DEPTH);
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: NO_PINGS,
  });

  const respondDeps: RespondDeps = {
    cfg,
    limits,
    budget,
    replies: { ...persona.replies, ...SAFETY_REPLIES },
    botName: persona.name,
    log,
    systemPrompt: () =>
      systemPrompt(persona, utcDay(), {
        quirk: Math.random() < persona.quirkRate,
        mentions: cfg.mentions,
        search: cfg.billing !== "free",
        timeZone: cfg.timeZone,
      }),
    downloadImages: (urls) => downloadImages(urls),
    readVideo: (urls) =>
      readVideo(cfg, urls, { reserve: (usd) => budget.tryReserve(usd), slots: videoSlots, gate: videoGate, log }),
    videoWatch: (video, room) =>
      new VideoWatch(
        video.frames,
        {
          extract: (from, to, perSecond) => extractWindow(video.url, from, to, perSecond, { gate: videoGate }),
          screen: (frames) => screenFrames(cfg, frames),
          log,
        },
        room,
      ),
    screenRequest: (question, replyTo, media) => screenRequest(cfg, question, replyTo, media),
    screenReply: (question, text) => screenReply(cfg, question, text),
    screenImages: (images, context) => screenImages(cfg, images, context),
    answer: (messages, { mayPingEveryone, mayCreateEvents, mayCreatePolls, refusals, video, links }) => {
      return answer(cfg, messages, {
        reserve: (usd) => budget.tryReserve(usd),
        videoTool: !!video,
        runTool: (name, args, tally) =>
          runTool(cfg, name, args, {
            state: toolState,
            tally,
            log,
            mayPingEveryone,
            mayCreateEvents,
            mayCreatePolls,
            refusals,
            video: video ?? undefined,
            links,
          }),
      });
    },
  };

  /** Translates one Discord message into a respond() request, then posts the outcome. */
  async function handle(message: Message): Promise<void> {
    const selfId = client.user?.id;
    const roles = [botRoleId(message)].filter((r): r is string => !!r);
    // The asker's own words without the mention of gork: what the @everyone check reads.
    const askerText = stripTrigger(message.content, selfId ?? "", roles);
    const question = toMsg(message, resolveNames(message, askerText), selfId);
    // Forwards also carry a reference, but their content is already in the snapshot; only follow real replies.
    const isReply = message.reference && message.reference.type !== MessageReferenceType.Forward;
    const ref = isReply ? await message.fetchReference().catch(() => null) : null;
    const replyTo = ref ? toMsg(ref, resolveNames(ref, ref.content), selfId) : null;
    const can = abilities(message);
    const eventNo = eventRefusal(message);
    const pollNo = pollRefusal(can);
    let stopTyping = () => {};
    let seen: Message[] = [];
    try {
      const outcome = await respond(
        {
          userId: message.author.id,
          who: `${message.author.username}(${message.author.id})`,
          where: message.guild?.name ?? "?",
          channelId: message.channelId,
          question,
          replyTo,
          ...splitImageUrls(message, ref),
          video: pickVideos([...videoSources(message), ...(ref ? videoSources(ref) : [])], cfg.tools.videosPerDay),
          can,
          mayPingEveryone: mayPingEveryone(cfg.mentions, askerCanMentionEveryone(message), askerText),
          mayCreateEvents: eventNo === null,
          mayCreatePolls: pollNo === null,
          refusals: { event: eventNo ?? undefined, poll: pollNo ?? undefined },
          history: async () => {
            const fetched = await message.channel.messages
              .fetch({ limit: cfg.limits.contextMessages, before: message.id })
              .catch(() => null);
            seen = fetched ? [...fetched.values()].filter((m) => m.id !== ref?.id).reverse() : [];
            return seen.map((m) => toMsg(m, resolveNames(m, m.content), selfId));
          },
          onWorking: () => {
            stopTyping = startTyping(message);
          },
        },
        respondDeps,
      );
      if (!outcome) return;
      const others = ref ? [ref, ...seen] : seen;
      const pings = { botId: selfId, allowed: cfg.mentions, everyoneRequested: outcome.pingEveryone };
      await sendReply(
        message,
        {
          text: outcome.text,
          files: outcome.files,
          given: givenLinks(question, replyTo),
          ping: (first) => pingFirstChunk(first, pingContext(message, others, pings)),
          previews: can.embeds,
        },
        log,
      );
      if (outcome.poll) await postPoll(message, outcome.poll, log);
      if (outcome.event) await postEvent(message, outcome.event, respondDeps.replies.eventFailed, log);
    } finally {
      stopTyping();
    }
  }

  client.on(Events.MessageCreate, (message) => {
    if (!client.user) return;
    const ch = message.channel;
    const triggered = shouldTrigger(
      {
        authorIsBot: message.author.bot,
        guildId: message.guildId,
        channelId: message.channelId,
        parentId: ch.isThread() ? ch.parentId : null,
        botId: client.user.id,
        botRoleId: botRoleId(message),
        mentionedUserIds: [...message.mentions.users.keys()],
        mentionedRoleIds: [...message.mentions.roles.keys()],
        content: message.content,
      },
      cfg,
    );
    if (triggered) handle(message).catch((err) => log(`handler failed: ${describeError(err)}`));
  });

  client.once(Events.ClientReady, async (c) => {
    log(
      `ready as ${c.user.tag} in ${c.guilds.cache.size} guild(s); budget today $${budget.spentToday.toFixed(4)}/$${budget.capUsd}`,
    );
    for (const g of c.guilds.cache.values()) {
      if (!cfg.guildIds.has(g.id)) {
        log(`note: in non-allowlisted guild ${g.name} (${g.id}); ignoring it`);
        continue;
      }
      // Which text channels can gork actually read and answer in? (Role/channel overrides often hide new bots.)
      const me = g.members.me;
      const text = [...g.channels.cache.values()].filter(
        (ch) => ch.isTextBased() && !ch.isThread() && !ch.isVoiceBased(),
      );
      const blind = text.filter(
        (ch) => !me || !ch.permissionsFor(me)?.has(["ViewChannel", "SendMessages", "ReadMessageHistory"]),
      );
      const polls = text.filter((ch) => !blind.includes(ch) && me && ch.permissionsFor(me)?.has("SendPolls")).length;
      log(
        `guild ${g.name}: can answer in ${text.length - blind.length}/${text.length} text channels${
          blind.length
            ? `; can't in: ${blind
                .slice(0, 15)
                .map((ch) => `#${ch.name}`)
                .join(", ")}`
            : ""
        }; can post polls in ${polls}`,
      );
    }
    const avatar = join(process.cwd(), "assets", "gork.png");
    if (!c.user.avatar && existsSync(avatar)) {
      await c.user
        .setAvatar(avatar)
        .then(() => log("avatar set"))
        .catch((e: unknown) => log(`avatar not set: ${describeError(e)}`));
    }
  });

  // Docker's HEALTHCHECK reads this: a fresh timestamp means the Discord connection is up (see heartbeat.ts).
  let connected = false;
  const heartbeat = startHeartbeat({
    isUp: () => connected,
    write: (content) => writeHeartbeat(HEARTBEAT_FILE, content),
    log,
  });
  const markUp = () => {
    connected = true;
    watchdog.markUp();
    heartbeat.beat();
  };
  const markDown = () => {
    connected = false;
    watchdog.markDown();
  };
  // Without an error listener, an emitted "error" would crash the process.
  client.on(Events.Error, (err) => log(`discord client error: ${describeError(err)}`));
  client.on(Events.Warn, (msg) => log(`discord warning: ${msg}`));
  client.on(Events.ShardDisconnect, (event) => {
    if (!isFatalCloseCode(event.code)) return markDown();
    // discord.js won't reconnect from these; stop instead of letting the watchdog restart into the same error.
    connected = false;
    heartbeat.stop();
    void client.destroy();
    fatal(
      "discord-gateway",
      `Discord closed the connection with code ${event.code} (bad token, or an intent such as Message Content isn't enabled in the Developer Portal)`,
    );
  });
  client.on(Events.ShardReconnecting, markDown);
  client.on(Events.ShardReady, markUp);
  client.on(Events.ShardResume, markUp);
  watchdog.start();

  // A stray rejection must not crash the process: each restart costs a Discord login, and those are rationed.
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${describeError(err)}`));

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      log(`${sig}, shutting down`);
      void client.destroy().finally(() => process.exit(0));
    });
  }

  try {
    await client.login(cfg.discordToken);
  } catch (err) {
    // A bad token or a disallowed intent never fixes itself; retrying would only burn Discord's daily login limit.
    if (isFatalLoginError(err)) return fatal("discord-login", describeError(err));
    throw err;
  }
}

await main();
