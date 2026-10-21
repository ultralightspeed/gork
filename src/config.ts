import { splitCsv } from "./csv.ts";
import { GUARD_CATEGORIES } from "./guard.ts";
import { type MentionKind, parseMentions } from "./mentions.ts";
import { SEARCH_PROVIDER_NAMES, SEARCH_PROVIDERS, type SearchProvider } from "./search-providers.ts";
import { isTimeZone } from "./time.ts";

/**
 * Every setting gork reads, in one table. Everything else is derived from it:
 * loadConfig (the bot), the CLI's validation, .env.example (scripts/env-example.ts) and the compose.yaml check.
 * To add a setting: add a row here, add the key to compose.yaml's `environment:`, run `node scripts/env-example.ts`.
 */

export const GROUPS = ["Discord", "Cloudflare", "Model", "Tools", "Safety", "Limits", "Host"] as const;
type Group = (typeof GROUPS)[number];

interface Setting<T = unknown> {
  group: Group;
  /** Used when the key is unset or blank, and shown in .env.example. Always blank for secrets and required keys. */
  default: string;
  /** Must be set for whoever reads it (the bot, or the CLI for host-scope keys). */
  required?: true;
  /**
   * Who reads the key. Unset: the bot, so it goes in .env.example and compose.yaml.
   * "host": only the CLI; never passed into the container.
   * "image": fixed by the Dockerfile (DATA_DIR); in neither .env.example nor compose.yaml.
   */
  scope?: "host" | "image";
  /** Never print or log the value. */
  secret?: true;
  /** One line, shown above the key in .env.example. */
  help: string;
  /** Turns the (trimmed, defaulted) text into a value, or throws an Error saying what is wrong (without the key). */
  parse(raw: string): T;
}

const setting = <T>(s: Setting<T>): Setting<T> => s;

const text = (raw: string) => raw;
const idSet = (raw: string) => new Set(splitCsv(raw));

function nonNegative(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error("must be a non-negative number");
  return n;
}
/** A whole number from `min` up (to `max` when given). Out of range is an error, never silently clamped. */
const wholeNumber =
  (min: number, max = Number.POSITIVE_INFINITY) =>
  (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(
        max === Number.POSITIVE_INFINITY
          ? `must be a whole number of at least ${min}`
          : `must be a whole number from ${min} to ${max}`,
      );
    }
    return n;
  };
function rate(raw: string): number {
  const n = nonNegative(raw);
  if (n > 1) throw new Error("must be between 0 and 1");
  return n;
}
const oneOf =
  <T extends string>(...allowed: T[]) =>
  (raw: string): T => {
    if (!allowed.includes(raw as T)) throw new Error(`must be one of ${allowed.join(", ")}`);
    return raw as T;
  };
/** Empty, docker or podman: the program that runs gork's container (blank: Docker if it works, else Podman). */
function containerEngine(raw: string): "" | "docker" | "podman" {
  const name = raw.toLowerCase();
  if (name !== "" && name !== "docker" && name !== "podman")
    throw new Error("must be one of docker, podman (or blank)");
  return name;
}
/** Empty, "build", or an image name or digest reference: lowercase, no spaces, and it can't start like a flag. */
function gorkImage(raw: string): string {
  if (raw === "" || raw === "build") return raw;
  if (!/^[a-z0-9][a-z0-9._/:@-]{0,254}$/.test(raw)) {
    throw new Error("must be build, or an image name such as ghcr.io/you/gork:1.0 (lowercase, no spaces)");
  }
  return raw;
}
/** Empty, or an https URL: a key is never sent over plain http. */
function httpsUrl(raw: string): string {
  if (raw === "") return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("must be an https:// URL");
  }
  if (url.protocol !== "https:") throw new Error("must be an https:// URL");
  return raw;
}
/** A Cloudflare account ID: 32 hex characters. */
function accountId(raw: string): string {
  if (!/^[0-9a-f]{32}$/i.test(raw)) throw new Error("must be 32 hex characters (the ID in your dashboard address)");
  return raw;
}
/** Goes into URL paths, so only letters, digits and hyphens, starting with a letter or digit, at most 64 long. */
const GATEWAY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
function gatewayId(raw: string): string {
  if (!GATEWAY_ID.test(raw))
    throw new Error("must be letters, digits and hyphens only (at most 64, not starting with -)");
  return raw;
}
/** An IANA time zone name such as UTC or America/New_York. */
function timeZone(raw: string): string {
  if (!isTimeZone(raw)) throw new Error("must be an IANA time zone name such as UTC or America/New_York");
  return raw;
}
/** Sexual content involving minors: screened whatever GUARD_BLOCK says. */
const ALWAYS_BLOCKED = "S4";

function guardBlock(raw: string): Set<string> {
  if (raw.toLowerCase() === "none") return new Set([ALWAYS_BLOCKED]);
  const ids = splitCsv(raw).map((s) => s.toUpperCase());
  const unknown = ids.filter((id) => !GUARD_CATEGORIES.includes(id));
  if (unknown.length || ids.length === 0) {
    throw new Error(
      `has ${unknown.length || "no"} unsupported categories; use some of ${GUARD_CATEGORIES.join(",")} or "none"`,
    );
  }
  return new Set([ALWAYS_BLOCKED, ...ids]);
}

/** The default model per BILLING_MODE. GLM 5.x needs Workers Paid or AI Gateway credits; 4.7-flash is on the free plan. */
export const CREDITS_MODEL = "@cf/zai-org/glm-5.3-flash";
export const FREE_MODEL = "@cf/zai-org/glm-4.7-flash";
/** Models that take no images: Workers AI rejects an image part with HTTP 400 "not a multimodal model". */
const TEXT_ONLY_MODELS = new Set([FREE_MODEL]);

export const SETTINGS = {
  DISCORD_TOKEN: setting({
    group: "Discord",
    default: "",
    required: true,
    secret: true,
    help: "Bot token: Developer Portal > your app > Bot > Reset Token (paste it yourself).",
    parse: text,
  }),
  GUILD_IDS: setting({
    group: "Discord",
    default: "",
    required: true,
    help: "Server IDs gork may answer in, comma-separated.",
    parse: idSet,
  }),
  ALLOWED_CHANNEL_IDS: setting({
    group: "Discord",
    default: "",
    help: "Limit gork to these channel IDs (threads follow their parent). Empty: any channel it can see in those servers.",
    parse: idSet,
  }),
  PERSONA: setting({
    group: "Discord",
    default: "default",
    help: "Personality: a preset from personas/ (default, witty, hype, noir, professor) or custom for your own personas/custom.md. Applied on the next npm run up.",
    parse: text,
  }),
  MENTIONS: setting({
    group: "Discord",
    default: "none",
    help: "Who gork may ping: none, all, or some of reply (the asker), users, roles, everyone. users = people in the conversation (at most 5 per reply). @everyone only when the asker may and asks for it; locked roles only if the asker could ping them.",
    parse: parseMentions,
  }),
  TIMEZONE: setting({
    group: "Discord",
    default: "UTC",
    help: 'Time zone for the events gork creates (an IANA name such as America/New_York). People say "Friday 8pm"; this is the clock that means.',
    parse: timeZone,
  }),

  CF_ACCOUNT_ID: setting({
    group: "Cloudflare",
    default: "",
    required: true,
    help: "Your Cloudflare account ID (32 hex characters).",
    parse: accountId,
  }),
  AI_GATEWAY_ID: setting({
    group: "Cloudflare",
    default: "gork",
    help: "AI Gateway that npm run up creates, and overwrites with gork's settings. Use a name nothing else uses.",
    parse: gatewayId,
  }),
  CF_RUN_TOKEN: setting({
    group: "Cloudflare",
    default: "",
    required: true,
    secret: true,
    help: "Runtime token (goes into the container): AI Gateway Read+Run, Workers AI Read, Websearch Run, Browser Run Write. Free mode needs only Workers AI Read and Browser Run Write.",
    parse: text,
  }),
  CF_ADMIN_TOKEN: setting({
    group: "Cloudflare",
    default: "",
    required: true,
    secret: true,
    scope: "host",
    help: "Admin token (host only, never in the container; used by npm run up, gateway and destroy): AI Gateway Read + Write.",
    parse: text,
  }),

  BILLING_MODE: setting({
    group: "Model",
    default: "credits",
    help: "credits: prepaid AI Gateway credits (default). free: Workers AI's free daily allowance only (about 10,000 neurons a day, roughly 25-100 replies), no web search, and its model is text-only so it can't see images (a video gives only its transcript; generating images still works), and when it runs out the safety check fails closed so gork stops answering until 00:00 UTC. Only free on the Workers Free plan: on Workers Paid, use past the daily allowance is billed.",
    parse: oneOf("credits", "free"),
  }),
  LLM_BASE_URL: setting({
    group: "Model",
    default: "",
    help: "OpenAI-compatible base URL (https only). Empty: Cloudflare Workers AI, through your AI Gateway (direct, no gateway, when BILLING_MODE=free).",
    parse: httpsUrl,
  }),
  LLM_MODEL: setting({
    group: "Model",
    default: "",
    help: `Model ID. Empty: ${CREDITS_MODEL}, or ${FREE_MODEL} when BILLING_MODE=free. Set the two prices below to match it.`,
    parse: text,
  }),
  LLM_API_KEY: setting({
    group: "Model",
    default: "",
    secret: true,
    help: "Key for LLM_BASE_URL. Empty: CF_RUN_TOKEN, which is only ever sent to Cloudflare endpoints.",
    parse: text,
  }),
  LLM_REASONING_EFFORT: setting({
    group: "Model",
    default: "low",
    help: "low, medium, high or max; off leaves the field out of the request (GLM-5.3 cannot turn reasoning off).",
    parse: oneOf("off", "low", "medium", "high", "max"),
  }),
  LLM_PRICE_IN_PER_M: setting({
    group: "Model",
    default: "0.15",
    help: "USD per million input tokens for LLM_MODEL; drives the spend estimate.",
    parse: nonNegative,
  }),
  LLM_PRICE_OUT_PER_M: setting({
    group: "Model",
    default: "0.50",
    help: "USD per million output tokens for LLM_MODEL.",
    parse: nonNegative,
  }),

  MAX_TOOL_CALLS: setting({
    group: "Tools",
    default: "6",
    help: "Tool calls per reply, counting every tool (search, page read, transcript, image, poll, event, video frames). 0 turns tools off.",
    parse: wholeNumber(0),
  }),
  SEARCH_PROVIDER: setting({
    group: "Tools",
    default: "ceramic",
    help: `Web Search provider on Cloudflare for a reply's first search: ceramic ($${SEARCH_PROVIDERS.ceramic.priceUsd} a search), linkup ($${SEARCH_PROVIDERS.linkup.priceUsd}) or exa ($${SEARCH_PROVIDERS.exa.priceUsd}; the only one that keeps a copy of your queries).`,
    parse: oneOf(...SEARCH_PROVIDER_NAMES),
  }),
  SEARCH_FALLBACK: setting({
    group: "Tools",
    default: "linkup",
    help: "Provider for a reply's further searches, and for a first search that fails or finds nothing: linkup, or none. Ignored when it is SEARCH_PROVIDER.",
    parse: oneOf("linkup", "none"),
  }),
  SEARCH_FALLBACK_PER_DAY: setting({
    group: "Tools",
    default: "20",
    help: `Fallback searches per UTC day, at most 2 in one reply ($${SEARCH_PROVIDERS.linkup.priceUsd} each with linkup, so 20 is at most $${(20 * SEARCH_PROVIDERS.linkup.priceUsd).toFixed(2)} a day). 0 turns the fallback off.`,
    parse: wholeNumber(0),
  }),
  FETCH_MAX_CHARS: setting({
    group: "Tools",
    default: "20000",
    help: "Most characters of a web page the model reads.",
    parse: wholeNumber(1),
  }),
  TRANSCRIPT_MAX_CHARS: setting({
    group: "Tools",
    default: "30000",
    help: "Most characters of a YouTube transcript the model reads.",
    parse: wholeNumber(1),
  }),
  IMAGES_PER_DAY: setting({
    group: "Tools",
    default: "50",
    help: "Images gork may generate per UTC day (FLUX.1 schnell, Workers AI's free daily allowance; free on the Workers Free plan, billed past the allowance on Workers Paid). 0 turns images off.",
    parse: wholeNumber(0),
  }),

  VIDEOS_PER_DAY: setting({
    group: "Tools",
    default: "20",
    help: "Videos gork may watch per UTC day (speech transcription uses the free daily allowance on Workers Free and is billed by the minute on Workers Paid). 0 turns video off (the same way IMAGES_PER_DAY=0 turns images off).",
    parse: wholeNumber(0),
  }),

  GUARD_BLOCK: setting({
    group: "Safety",
    default: GUARD_CATEGORIES.join(","),
    help: `Safety-screen categories to block: some of ${GUARD_CATEGORIES.join(",")}, or none. S4 (sexual content involving minors) is always on, whatever you set.`,
    parse: guardBlock,
  }),
  GUARD_THRESHOLD: setting({
    group: "Safety",
    default: "0.5",
    help: "Block when the screen's probability of a violation is at least this (0 to 1).",
    parse: rate,
  }),
  STRIKE_LIMIT: setting({
    group: "Safety",
    default: "3",
    help: "Blocked requests in 24 hours before gork ignores that person. 0 never mutes.",
    parse: wholeNumber(0),
  }),

  DAILY_BUDGET_USD: setting({
    group: "Limits",
    default: "0.50",
    help: "Spend cap per UTC day, as gork estimates it. npm run up sets the AI Gateway spend limit to about 1.2x this as a backstop.",
    parse: nonNegative,
  }),
  COOLDOWN_SECONDS: setting({
    group: "Limits",
    default: "3",
    help: "Seconds a person waits between requests.",
    parse: nonNegative,
  }),
  CONTEXT_MESSAGES: setting({
    group: "Limits",
    default: "50",
    help: "Recent messages gork reads, 1 to 100 (Discord's limit), each cut to 300 characters.",
    parse: wholeNumber(1, 100),
  }),
  CONTAINER_ENGINE: setting({
    group: "Host",
    default: "",
    scope: "host",
    help: "Which program runs gork's container: docker or podman. Empty: Docker if it is running, otherwise Podman.",
    parse: containerEngine,
  }),
  GORK_IMAGE: setting({
    group: "Host",
    default: "",
    scope: "host",
    help: "Empty: npm run up downloads the released image from GitHub (and builds it here if that fails). build: always build it here. Or the name of an image to run instead.",
    parse: gorkImage,
  }),
  DATA_DIR: setting({
    group: "Limits",
    default: "./data",
    scope: "image",
    help: "Where gork keeps its spend ledger. The Docker image sets /data; running on the host uses ./data.",
    parse: text,
  }),
} satisfies Record<string, Setting>;

export type SettingKey = keyof typeof SETTINGS;
type Values = { [K in SettingKey]: ReturnType<(typeof SETTINGS)[K]["parse"]> };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

type Env = Record<string, string | undefined>;

/** The line to log at startup: what the safety screen blocks, and that S4 can't be switched off. */
export function guardNotice(block: Set<string>): string {
  return `safety screen: ${ALWAYS_BLOCKED} (sexual content involving minors) is always on; blocking ${[...block].sort().join(", ")}`;
}

/** Bad or missing settings. The message names every key at fault, never a secret's value. */
export class SettingsError extends Error {}

/**
 * Parses just the given keys from `env`: required ones must be set, blank means the default, and every problem
 * is reported at once. The bot reads all of its keys through loadConfig; the CLI reads the few it needs.
 * Keys in `env` that aren't settings are ignored, so a .env with extra keys still works.
 */
export function readSettings<K extends SettingKey>(env: Env, keys: readonly K[]): Pick<Values, K> {
  const problems: string[] = [];
  const missing = keys.filter((k) => SETTINGS[k].required && !env[k]?.trim());
  if (missing.length) problems.push(`Missing required settings: ${missing.join(", ")} (see .env.example)`);
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    if (missing.includes(key)) continue;
    const s = SETTINGS[key];
    try {
      values[key] = s.parse(env[key]?.trim() || s.default);
    } catch (err) {
      problems.push(`${key} ${(err as Error).message}`);
    }
  }
  if (problems.length) throw new SettingsError(problems.join("; "));
  return values as Pick<Values, K>;
}

/**
 * The provider for a reply's further searches, and for a first search that fails or finds nothing; null when there is
 * none: SEARCH_FALLBACK=none, the same provider as SEARCH_PROVIDER, or SEARCH_FALLBACK_PER_DAY=0.
 */
export function searchFallbackOf(
  s: Pick<Values, "SEARCH_PROVIDER" | "SEARCH_FALLBACK" | "SEARCH_FALLBACK_PER_DAY">,
): SearchProvider | null {
  if (s.SEARCH_FALLBACK === "none" || s.SEARCH_FALLBACK === s.SEARCH_PROVIDER || s.SEARCH_FALLBACK_PER_DAY === 0)
    return null;
  return s.SEARCH_FALLBACK;
}
export interface Config {
  discordToken: string;
  guildIds: Set<string>;
  allowedChannelIds: Set<string>;
  /** Persona preset name: personas/<persona>.md. */
  persona: string;
  /** BILLING_MODE: free means Workers AI direct on the free allowance, no gateway and no web search. */
  billing: "credits" | "free";
  /** Which pings replies may carry (MENTIONS). */
  mentions: Set<MentionKind>;
  /** TIMEZONE: the clock "8pm" refers to when someone asks for an event. */
  timeZone: string;
  dataDir: string;
  cf: { accountId: string; gatewayId: string; runToken: string };
  llm: {
    baseUrl: string;
    model: string;
    apiKey: string;
    reasoningEffort: string;
    priceInPerM: number;
    priceOutPerM: number;
    /** The model takes images; when it doesn't, gork sends it none (no attached images, no video frames). */
    vision: boolean;
  };
  tools: {
    maxCalls: number;
    searchProvider: SearchProvider;
    /** Null when there is none: SEARCH_FALLBACK=none, the same as SEARCH_PROVIDER, or SEARCH_FALLBACK_PER_DAY=0. */
    searchFallback: SearchProvider | null;
    searchFallbackPerDay: number;
    fetchMaxChars: number;
    transcriptMaxChars: number;
    imagesPerDay: number;
    /** 0 turns video off. */
    videosPerDay: number;
  };
  guard: { block: Set<string>; threshold: number; strikeLimit: number };
  limits: {
    dailyBudgetUsd: number;
    cooldownSeconds: number;
    contextMessages: number;
  };
}

const CLOUDFLARE_HOSTS = new Set(["api.cloudflare.com", "gateway.ai.cloudflare.com"]);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function llmKey(explicit: string, baseUrl: string, runToken: string): string {
  if (explicit) return explicit;
  if (!CLOUDFLARE_HOSTS.has(hostOf(baseUrl))) {
    throw new SettingsError(
      "LLM_API_KEY is required when LLM_BASE_URL is not a Cloudflare endpoint (the Cloudflare token is never sent elsewhere)",
    );
  }
  return runToken;
}

/** Everything the bot reads (all keys except the host-only ones), arranged for use. */
export function loadConfig(env: Env = process.env): Config {
  const botKeys = SETTING_KEYS.filter((k) => SETTINGS[k].scope !== "host");
  const s = readSettings(env, botKeys);
  const model = s.LLM_MODEL || (s.BILLING_MODE === "free" ? FREE_MODEL : CREDITS_MODEL);
  const baseUrl = s.LLM_BASE_URL || `https://api.cloudflare.com/client/v4/accounts/${s.CF_ACCOUNT_ID}/ai/v1`;
  // Free mode promises nothing is ever billed, so the model must be Workers AI called directly, not the gateway.
  if (s.BILLING_MODE === "free" && hostOf(baseUrl) !== "api.cloudflare.com") {
    throw new SettingsError(
      "BILLING_MODE=free needs LLM_BASE_URL empty (Workers AI direct); the gateway and other providers can bill you",
    );
  }
  return {
    discordToken: s.DISCORD_TOKEN,
    guildIds: s.GUILD_IDS,
    allowedChannelIds: s.ALLOWED_CHANNEL_IDS,
    persona: s.PERSONA,
    billing: s.BILLING_MODE,
    mentions: s.MENTIONS,
    timeZone: s.TIMEZONE,
    dataDir: s.DATA_DIR,
    cf: { accountId: s.CF_ACCOUNT_ID, gatewayId: s.AI_GATEWAY_ID, runToken: s.CF_RUN_TOKEN },
    llm: {
      baseUrl,
      model,
      apiKey: llmKey(s.LLM_API_KEY, baseUrl, s.CF_RUN_TOKEN),
      reasoningEffort: s.LLM_REASONING_EFFORT,
      priceInPerM: s.LLM_PRICE_IN_PER_M,
      priceOutPerM: s.LLM_PRICE_OUT_PER_M,
      vision: !TEXT_ONLY_MODELS.has(model),
    },
    tools: {
      maxCalls: s.MAX_TOOL_CALLS,
      searchProvider: s.SEARCH_PROVIDER,
      searchFallback: searchFallbackOf(s),
      searchFallbackPerDay: s.SEARCH_FALLBACK_PER_DAY,
      fetchMaxChars: s.FETCH_MAX_CHARS,
      transcriptMaxChars: s.TRANSCRIPT_MAX_CHARS,
      imagesPerDay: s.IMAGES_PER_DAY,
      videosPerDay: s.VIDEOS_PER_DAY,
    },
    guard: { block: s.GUARD_BLOCK, threshold: s.GUARD_THRESHOLD, strikeLimit: s.STRIKE_LIMIT },
    limits: {
      dailyBudgetUsd: s.DAILY_BUDGET_USD,
      cooldownSeconds: s.COOLDOWN_SECONDS,
      contextMessages: s.CONTEXT_MESSAGES,
    },
  };
}
