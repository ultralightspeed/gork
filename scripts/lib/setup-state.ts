// The setup session's state, as plain data: what each step has learned, and the View the page is allowed to see.
// The steps (setup-step-*.ts) change it; setup-view.ts turns it into a View; setup-session.ts is what the server calls.
import type { Account, Probe, TokenSummary } from "./cloudflare-setup.ts";
import type { CustomDraft } from "./custom-persona.ts";
import type { Application } from "./discord-setup.ts";
import type { HostOps, Privacy } from "./env-file.ts";
import type { Api } from "./gateway.ts";

/** What the session needs from outside it, all replaceable in tests. */
export interface SetupDeps {
  fetch: typeof fetch;
  now: () => number;
  /** Where .env is written. Setup never reads it, and refuses to start if it exists. */
  envPath: string;
  /** Folder holding the persona presets. */
  personasDir: string;
  /** Platform, user name and command runner for locking down .env; defaults to the real ones. */
  host?: HostOps;
  /** A line for the terminal that started setup. Never a secret. */
  print?: (line: string) => void;
  /** Ends the process (after Ctrl-C cleanup). */
  exit?: (code: number) => void;
  /** How long stopping setup waits for a step that is still running before it cleans up anyway. Default 20 seconds. */
  settleMs?: number;
  /**
   * Starts gork the way `npm run up` does, with these settings (what was just written to .env). Resolves with the line
   * saying gork is ready; throws CliError (EngineMissingError when there is no Docker or Podman to use).
   */
  startBot(
    env: Record<string, string>,
    hooks: { step(text: string): void; output(line: string): void; warn(line: string): void },
  ): Promise<string>;
}

export const ENV_HEADER = [
  "# Written by `npm run setup`. Every setting is listed with what it does; change any and run npm run up.",
  "# Comments must be on their own lines, and values are not quoted.",
];
export const ADMIN_LIFETIME_MS = 60 * 60 * 1000;
/** The page asks every few seconds; Discord and Cloudflare are asked no more often than this, however often it does. */
export const DISCORD_GAP_MS = 2500;
export const CREDITS_GAP_MS = 4000;
export const OWN_TOKEN_NAMES = ["gork-run", "gork-admin"];
export const TAIL_LINES = 40;
export const NOTE_LINES = 60;
export const TAKING_BACK = "Taking back what was made for this setup";

export type Billing = "credits" | "free";
type ProbeView = { capability: string; ok: boolean; message: string; kind?: "credits" };

export type ChoicesInput = Partial<
  Record<"billing" | "persona" | "mentions" | "timezone" | "budget" | "custom", unknown>
>;

export type Choices = {
  billing: Billing;
  persona: string;
  /** Normalised: "none", "all" or a comma list in a fixed order. */
  mentions: string;
  mentionsEveryone: boolean;
  timezone: string;
  budget: string;
};

type DiscordState = {
  token: string;
  app: Application | null;
  appName: string;
  intent: { ok: boolean; message: string } | null;
  publicBot: "off" | "on" | null;
  guilds: { id: string; name: string }[] | null;
  guildsProblem: string | null;
  problem: string | null;
  selected: { id: string; name: string }[] | null;
  lastPoll: number;
  /** Discord asked us to wait: no look before this time. */
  notBefore: number;
};

type CfPhase = "token" | "account" | "gateway" | "ready";
type CfState = {
  phase: CfPhase;
  token: string;
  keepAdmin: boolean;
  accountId: string;
  accounts: Account[] | null;
  accountProblem: string | null;
  older: TokenSummary[];
  olderProblem: string | null;
  runToken: string;
  adminToken: string;
  adminApi: Api | null;
  conflict: { id: string; summary: string[] } | null;
  gatewayId: string;
  probes: Probe[];
  failure: string | null;
  failureNotes: string[];
  needNewToken: boolean;
  lastCredits: number;
};

type FinishState = {
  written: boolean;
  privacy: Privacy | null;
  notes: string[];
  setupToken: "deleted" | "still-active" | null;
  oldTokens: { revoked: number; left: string[] } | null;
};

export type WorkId = "discord" | "cloudflare" | "finish";
/** A step that takes a while, as the page shows it: what it does, and how far it has got. */
export type Work = { id: WorkId; steps: { label: string; state: "done" | "active" | "todo" }[] };

type StartState = {
  status: "idle" | "running" | "online" | "docker" | "failed";
  steps: string[];
  tail: string[];
  message: string | null;
};

/** Everything the page may know. No field here is ever a secret. */
export type View = {
  envName: string;
  envExists: boolean;
  step: "choices" | "discord" | "cloudflare" | "finish";
  options: { personas: { name: string; description: string }[] };
  /** The custom personality editor: what it starts with, what it may hold, and what the last save warned about. */
  custom: {
    /** personas/custom.md exists now (saving replaces it). */
    exists: boolean;
    draft: CustomDraft;
    warnings: string[];
    replyFields: { key: string; label: string; placeholder: string }[];
    limits: { name: number; body: number; quirk: number; reply: number };
  };
  links: {
    discordApp: string;
    discordApps: string;
    cloudflareToken: string;
    cloudflareSignup: string;
    tokens: string;
    credits: string;
    docker: string;
    podman: string;
  };
  choices: Choices | null;
  discord: {
    app: { name: string } | null;
    intent: { ok: boolean; message: string } | null;
    publicBot: "off" | "on" | null;
    inviteUrl: string | null;
    guilds: { id: string; name: string }[] | null;
    guildsProblem: string | null;
    problem: string | null;
    selected: { id: string; name: string }[] | null;
  };
  cloudflare: {
    phase: CfPhase;
    accounts: Account[] | null;
    accountProblem: string | null;
    /** The gateway already in the way, and a different name to offer for gork's own. */
    gateway: { id: string; summary: string[]; suggestion: string } | null;
    older: { id: string; name: string }[];
    olderProblem: string | null;
    probes: ProbeView[];
    needsCredits: boolean;
    failure: string | null;
    failureNotes: string[];
    needNewToken: boolean;
  };
  finish: FinishState;
  start: StartState & { servers: string[] };
  /** The step that is running right now (it can take half a minute), or null. */
  work: Work | null;
  notes: string[];
};

export const OUT_OF_ORDER = "Do the earlier steps first.";

export const text = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);

export const fresh = {
  discord: (): DiscordState => ({
    token: "",
    app: null,
    appName: "",
    intent: null,
    publicBot: null,
    guilds: null,
    guildsProblem: null,
    problem: null,
    selected: null,
    lastPoll: Number.NEGATIVE_INFINITY,
    notBefore: Number.NEGATIVE_INFINITY,
  }),
  cf: (keepAdmin = true): CfState => ({
    phase: "token",
    token: "",
    keepAdmin,
    accountId: "",
    accounts: null,
    accountProblem: null,
    older: [],
    olderProblem: null,
    runToken: "",
    adminToken: "",
    adminApi: null,
    conflict: null,
    gatewayId: "",
    probes: [],
    failure: null,
    failureNotes: [],
    needNewToken: false,
    lastCredits: Number.NEGATIVE_INFINITY,
  }),
  finish: (): FinishState => ({ written: false, privacy: null, notes: [], setupToken: null, oldTokens: null }),
  start: (): StartState => ({ status: "idle", steps: [], tail: [], message: null }),
};

/** A name to offer when a gateway is already called `id`: `-2` on the end, or one more than a number already there. */
export function suggestGatewayName(id: string): string {
  const m = /^(.*?)-(\d{1,9})$/.exec(id);
  const tail = `-${m ? Number(m[2]) + 1 : 2}`;
  const base = m ? m[1] : id;
  return `${base.slice(0, 64 - tail.length).replace(/-+$/, "")}${tail}`;
}

/**
 * The KEY=value lines of an env file in the form setup writes (see renderEnv): unquoted values, no `export`, comments on
 * their own lines. Not a general .env parser: quotes and `export` are taken literally.
 */
export function parseEnvText(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]));
}
