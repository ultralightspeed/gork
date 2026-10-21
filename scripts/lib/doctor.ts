// `gork doctor`: checks every setting and each account it points at, and says exactly what to fix.
// Reads settings through the SETTINGS table and never prints a value: findings name keys, not contents.
// Network calls go through the injected fetch, so tests use fakes.

import { withoutSecrets } from "../../src/cf.ts";
import {
  type Config,
  loadConfig,
  readSettings,
  SETTING_KEYS,
  SETTINGS,
  type SettingKey,
  SettingsError,
} from "../../src/config.ts";
import { parseMentions } from "../../src/mentions.ts";
import { listPersonas, loadPersona } from "../../src/persona.ts";
import { describeSearch } from "../../src/search.ts";
import { SEARCH_PROVIDERS, searchPrice } from "../../src/search-providers.ts";
import { ADMIN_NEEDS, probeAdminToken, probeRunToken, runNeeds } from "./cloudflare-setup.ts";
import {
  canCreateEventsIn,
  getApplication,
  INTENT_STEPS,
  inviteUrl,
  listGuilds,
  messageContentOn,
} from "./discord-setup.ts";
import { type Engine, EngineMissingError } from "./engine.ts";
import { CliError } from "./errors.ts";
import { cloudflareApi } from "./gateway.ts";
import { chooseImage, packageVersion } from "./image.ts";
import { printable } from "./text.ts";

/**
 * One result. `id` names the check (and, after a colon, the setting or capability it is about); it stays the same from
 * run to run, so a program reading `npm run doctor -- --json` can rely on it. Several findings may share an id.
 */
export type Finding = { id: string; level: "ok" | "warn" | "fail"; text: string };

export type DoctorDeps = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** The folder holding persona presets and personas/custom.md. */
  personasDir: string;
  /** Also run the probes that cost money (a web search on each search provider). Default: only the free checks. */
  live?: boolean;
  /** Finds the container engine (Docker or Podman). Absent: the engine isn't checked. */
  engine?: () => Engine;
};

const names = (needs: ReturnType<typeof runNeeds>) => needs.map((n) => n.names[0]).join(" + ");
const csv = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Where to get a missing required setting. */
function missingFix(key: SettingKey, billing: "credits" | "free"): string {
  const tokens = "https://dash.cloudflare.com/?to=/:account/api-tokens";
  switch (key) {
    case "DISCORD_TOKEN":
      return "DISCORD_TOKEN is missing: Developer Portal (https://discord.com/developers/applications) > your app > Bot > Reset Token, then copy it into .env";
    case "GUILD_IDS":
      return "GUILD_IDS is missing: add the bot to your server, then put the server's ID here (Discord > Settings > Advanced > Developer Mode, right-click the server > Copy Server ID)";
    case "CF_ACCOUNT_ID":
      return "CF_ACCOUNT_ID is missing: it is the 32-character ID in your Cloudflare dashboard address (https://dash.cloudflare.com/<id>/...)";
    case "CF_RUN_TOKEN":
      return `CF_RUN_TOKEN is missing: create it at ${tokens} with these permissions: ${names(runNeeds(billing))}`;
    case "CF_ADMIN_TOKEN":
      return `CF_ADMIN_TOKEN is missing: create it at ${tokens} with these permissions: ${names(ADMIN_NEEDS)}`;
    default:
      return `${key} is missing (see .env.example)`;
  }
}

type Billing = "credits" | "free";

/** Collects findings in order; each check function builds its own. */
function collector() {
  const found: Finding[] = [];
  const add = (level: Finding["level"]) => (id: string, text: string) => void found.push({ id, level, text });
  return { found, ok: add("ok"), warn: add("warn"), fail: add("fail") };
}

const envValue = (d: DoctorDeps, key: string) => d.env[key]?.trim() ?? "";

/** What the settings check learned, for the checks that come after it. */
type SettingsState = {
  findings: Finding[];
  billing: Billing;
  /** Keys that are missing or invalid, already reported. */
  bad: Set<SettingKey>;
  /** GUILD_IDS is reported by the Discord check, which can put the invite link in the message. */
  guildIdsMissing: boolean;
  /** The bot's whole config, or null when it can't be built. */
  cfg: Config | null;
};

/** Settings, one key at a time so each problem gets its own fix. */
function checkSettings(d: DoctorDeps): SettingsState {
  const { found, ok, warn, fail } = collector();
  let billing: Billing = "credits";
  try {
    billing = readSettings(d.env, ["BILLING_MODE"]).BILLING_MODE;
  } catch {
    /* reported below */
  }
  const bad = new Set<SettingKey>();
  let guildIdsMissing = false;
  for (const key of SETTING_KEYS) {
    const s = SETTINGS[key];
    if (s.scope === "image") continue;
    if (s.required && !envValue(d, key)) {
      bad.add(key);
      if (key === "GUILD_IDS") guildIdsMissing = true;
      else fail(`settings:${key}`, missingFix(key, billing));
      continue;
    }
    try {
      readSettings(d.env, [key]);
    } catch (err) {
      bad.add(key);
      fail(`settings:${key}`, `${(err as Error).message}`);
    }
  }
  let cfg: Config | null = null;
  if (![...bad].some((k) => SETTINGS[k].scope !== "host")) {
    try {
      cfg = loadConfig(d.env);
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      fail("settings", err.message);
    }
  }
  if (bad.size === 0 && cfg) ok("settings", "settings: every key is valid");
  if (cfg && billing === "free") {
    ok(
      "billing.free-plan",
      "BILLING_MODE=free is only free on the Workers Free plan: on Workers Paid, use past the daily allowance (10,000 neurons) is billed at $0.011 per 1,000",
    );
    if (/glm-5/i.test(cfg.llm.model)) {
      warn(
        "billing.free-model",
        `BILLING_MODE=free with LLM_MODEL=${cfg.llm.model}: GLM 5.x models need the Workers Paid plan or credits and fail on the free plan; clear LLM_MODEL to use @cf/zai-org/glm-4.7-flash`,
      );
    }
  }
  return { findings: found, billing, bad, guildIdsMissing, cfg };
}

/** Which container engine `npm run up` will use, or what is wrong with every one that is installed. */
function checkEngine(d: DoctorDeps): Finding[] {
  if (!d.engine) return [];
  try {
    const e = d.engine();
    return [
      {
        id: "engine",
        level: "ok",
        text: `container engine: ${e.label}${e.version ? ` ${e.version}` : ""} (${e.compose.join(" ")})`,
      },
    ];
  } catch (err) {
    if (!(err instanceof EngineMissingError)) throw err;
    return [{ id: "engine", level: "fail", text: err.message }];
  }
}

/** Which image `npm run up` will start, in words. A GORK_IMAGE that isn't valid is reported by the settings check. */
function checkImage(d: DoctorDeps, bad: Set<SettingKey>): Finding[] {
  if (bad.has("GORK_IMAGE")) return [];
  const plan = chooseImage(envValue(d, "GORK_IMAGE"), false, packageVersion());
  const text =
    plan.mode === "build"
      ? "gork image: npm run up builds gork here (GORK_IMAGE=build)"
      : plan.custom
        ? `gork image: npm run up runs ${plan.ref} (GORK_IMAGE)`
        : `gork image: npm run up downloads ${plan.ref}, and builds gork here only if that fails; npm run up -- --build always builds here`;
  return [{ id: "image", level: "ok", text }];
}

function checkPersona(d: DoctorDeps, bad: Set<SettingKey>): Finding[] {
  const { found, ok, warn, fail } = collector();
  if (bad.has("PERSONA")) return found;
  const name = envValue(d, "PERSONA") || SETTINGS.PERSONA.default;
  let choices: string[] = [];
  try {
    choices = listPersonas(d.personasDir);
  } catch {
    /* no folder: reported as not found */
  }
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    fail("persona", "PERSONA must be letters, numbers, - or _");
  } else if (!choices.includes(name)) {
    fail(
      "persona",
      name === "custom"
        ? `PERSONA "custom" not found: copy personas/custom.example.md to personas/custom.md and edit it (choices now: ${choices.join(", ") || "none"})`
        : `PERSONA "${name}" not found, choices: ${choices.join(", ") || "none"} (or custom, after copying personas/custom.example.md to personas/custom.md)`,
    );
  } else {
    try {
      const persona = loadPersona(d.personasDir, name);
      ok("persona", `persona "${name}" loads`);
      for (const w of persona.warnings) warn("persona.warning", `persona "${name}": ${w}`);
    } catch (err) {
      fail("persona", `PERSONA ${printable((err as Error).message, 200)}`);
    }
  }
  return found;
}

const wantsEveryone = (raw: string | undefined): boolean => {
  try {
    return parseMentions(raw?.trim() || "none").has("everyone");
  } catch {
    return false;
  }
};

/** The Discord token, the Message Content intent and Public Bot, then whether the bot is in the configured servers. */
async function checkDiscord(d: DoctorDeps, s: SettingsState): Promise<Finding[]> {
  const { found, ok, warn, fail } = collector();
  const token = envValue(d, "DISCORD_TOKEN");
  if (!token) {
    if (s.guildIdsMissing) fail("settings:GUILD_IDS", missingFix("GUILD_IDS", s.billing));
    return found;
  }
  try {
    const app = await getApplication(token, d.fetch);
    ok("discord.token", `Discord token is valid (application "${printable(app.name)}")`);
    const invite = inviteUrl(app.id, { mentionEveryone: wantsEveryone(d.env.MENTIONS) });
    if (messageContentOn(app.flags)) ok("discord.intent", "Message Content intent is on");
    else {
      fail(
        "discord.intent",
        `Message Content intent is off: turn it on at ${INTENT_STEPS}. Until then gork can't start (Discord closes the connection with code 4014).`,
      );
    }
    if (app.bot_public) {
      warn(
        "discord.public-bot",
        "the app is public (Public Bot is on): turn it off on the Bot page so only you can add it; gork ignores servers outside GUILD_IDS either way",
      );
    }
    found.push(...(await checkServers(d, s, token, invite)));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    fail("discord.token", `DISCORD_TOKEN: ${err.message}`);
    if (s.guildIdsMissing) fail("settings:GUILD_IDS", missingFix("GUILD_IDS", s.billing));
  }
  return found;
}

/** Whether the bot is in a server listed in GUILD_IDS. A server list that can't be read is a warning, not a verdict. */
async function checkServers(d: DoctorDeps, s: SettingsState, token: string, invite: string): Promise<Finding[]> {
  const { found, ok, warn, fail } = collector();
  try {
    const guilds = await listGuilds(token, d.fetch);
    const inBot = new Set(guilds.map((g) => g.id));
    const wanted = [...(s.cfg?.guildIds ?? csv(envValue(d, "GUILD_IDS")))];
    if (s.guildIdsMissing) {
      fail(
        "settings:GUILD_IDS",
        `GUILD_IDS is missing: add the bot to your server with ${invite}, then put the server's ID here`,
      );
    } else if (!wanted.some((id) => inBot.has(id))) {
      fail("discord.servers", `bot isn't in any server in GUILD_IDS: open ${invite} and add it to your server`);
    } else {
      ok("discord.servers", "the bot is in a server listed in GUILD_IDS");
      for (const g of guilds.filter((x) => wanted.includes(x.id))) {
        if (g.permissions !== undefined && !canCreateEventsIn(g.permissions)) {
          warn(
            "discord.events",
            `the bot can't create events in "${printable(g.name)}" (it lacks Create Events), so gork will decline when asked for one; everything else works. Give its role Create Events, or add it again with ${invite}`,
          );
        }
      }
      const absent = wanted.filter((id) => !inBot.has(id));
      if (absent.length) {
        warn(
          "discord.servers",
          `GUILD_IDS lists ${absent.join(", ")}, which the bot isn't in; add it with ${invite} or remove the ID`,
        );
      }
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    warn("discord.servers", `couldn't check the bot's servers: ${err.message}`);
    if (s.guildIdsMissing) fail("settings:GUILD_IDS", missingFix("GUILD_IDS", s.billing));
  }
  return found;
}

/** The gateway through the admin token, then each capability through the run token. */
async function checkCloudflare(d: DoctorDeps, s: SettingsState): Promise<Finding[]> {
  const account = envValue(d, "CF_ACCOUNT_ID");
  const found: Finding[] = [];
  // The account and gateway ids go into URL paths, so only valid ones are used.
  const idsOk = !s.bad.has("CF_ACCOUNT_ID") && !s.bad.has("AI_GATEWAY_ID") && !s.bad.has("BILLING_MODE");
  if (account && envValue(d, "CF_ADMIN_TOKEN") && idsOk) {
    found.push(...(await checkGateway(d, s.billing, account)));
  }
  if (account && envValue(d, "CF_RUN_TOKEN") && s.cfg) found.push(...(await checkRunToken(d, s, account, s.cfg)));
  return found;
}

async function checkGateway(d: DoctorDeps, billing: Billing, account: string): Promise<Finding[]> {
  const { found, ok, warn, fail } = collector();
  const id = envValue(d, "AI_GATEWAY_ID") || SETTINGS.AI_GATEWAY_ID.default;
  try {
    const p = await probeAdminToken(cloudflareApi(account, envValue(d, "CF_ADMIN_TOKEN"), d.fetch), id);
    if (!p.ok) {
      fail("cloudflare.admin-token", `CF_ADMIN_TOKEN: ${p.message}`);
      return found;
    }
    if (!p.exists) {
      const say = billing === "free" ? warn : fail;
      say("cloudflare.gateway", `AI Gateway "${id}" doesn't exist: run \`npm run up\` to create it`);
      return found;
    }
    const mode = p.gateway?.workers_ai_billing_mode;
    if (billing === "free" && mode !== "standard") {
      fail(
        "cloudflare.gateway",
        `BILLING_MODE=free but AI Gateway "${id}" bills Workers AI to credits: run \`npm run gateway\` to switch it to standard billing`,
      );
    } else if (billing === "credits" && mode === "standard") {
      fail(
        "cloudflare.gateway",
        `BILLING_MODE=credits but AI Gateway "${id}" is on standard billing, so credits won't be used: run \`npm run gateway\``,
      );
    } else {
      ok("cloudflare.gateway", `AI Gateway "${id}" exists and its billing matches BILLING_MODE=${billing}`);
    }
    const differs = [
      p.gateway?.authentication !== true && "authentication",
      p.gateway?.zdr !== true && "zdr",
      (p.gateway?.spend_limits as { enabled?: unknown } | undefined)?.enabled !== true && "spend limit",
    ].filter(Boolean);
    if (differs.length) {
      warn(
        "cloudflare.gateway-settings",
        `AI Gateway "${id}" differs from gork's settings (${differs.join(", ")}): run \`npm run gateway\` to reset it`,
      );
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    fail("cloudflare.admin-token", `CF_ADMIN_TOKEN: ${err.message}`);
  }
  return found;
}

async function checkRunToken(d: DoctorDeps, s: SettingsState, account: string, cfg: Config): Promise<Finding[]> {
  const { found, ok, warn, fail } = collector();
  const customLlm = !!envValue(d, "LLM_BASE_URL");
  const fallback = cfg.tools.searchFallback;
  if (s.billing === "credits") {
    ok("search.providers", describeSearch(cfg));
    if (SEARCH_PROVIDERS[cfg.tools.searchProvider].keepsQueries)
      warn(
        "search.keeps-queries",
        `SEARCH_PROVIDER: ${cfg.tools.searchProvider} keeps a copy of your search queries; ceramic and linkup don't (zero data retention)`,
      );
  }
  try {
    const probes = await probeRunToken(
      {
        accountId: account,
        token: envValue(d, "CF_RUN_TOKEN"),
        gatewayId: cfg.cf.gatewayId,
        billing: s.billing,
        model: cfg.llm.model,
        searchProvider: cfg.tools.searchProvider,
        fallbackProvider: fallback,
        search: !!d.live,
      },
      d.fetch,
    );
    for (const p of probes) {
      if (customLlm && p.capability === "chat") continue;
      const id = `cloudflare.run:${p.capability.replaceAll(" ", "-")}`;
      if (p.ok) ok(id, `CF_RUN_TOKEN, ${p.capability}: ${p.message}`);
      else fail(id, `CF_RUN_TOKEN, ${p.capability}: ${p.message}`);
    }
    if (s.billing === "credits" && !d.live) {
      const prices = [cfg.tools.searchProvider, ...(fallback ? [fallback] : [])].map(searchPrice);
      const cost = prices.reduce((a, b) => a + b, 0);
      const what = prices.length > 1 ? "the two tests cost" : "the test costs";
      ok(
        "cloudflare.run:web-search",
        `CF_RUN_TOKEN, web search: skipped, because ${what} about $${Number(cost.toFixed(5))}; run \`npm run doctor -- --live\` to include it`,
      );
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    fail("cloudflare.run", `CF_RUN_TOKEN: ${err.message}`);
  }
  return found;
}

/**
 * Runs every check and returns the findings in the order to print them. Findings never hold a setting's value by
 * design; as a backstop, any secret setting's value that a server repeated back is replaced in every finding.
 */
export async function diagnose(d: DoctorDeps): Promise<Finding[]> {
  const settings = checkSettings(d);
  const found = [
    ...settings.findings,
    ...checkEngine(d),
    ...checkImage(d, settings.bad),
    ...checkPersona(d, settings.bad),
    ...(await checkDiscord(d, settings)),
    ...(await checkCloudflare(d, settings)),
  ];
  const secrets = SETTING_KEYS.filter((k) => (SETTINGS[k] as { secret?: true }).secret === true)
    .map((k) => envValue(d, k))
    .sort((a, b) => b.length - a.length);
  return found.map((f) => ({ ...f, text: withoutSecrets(f.text, ...secrets) }));
}
