// Step 4 of setup: write .env (only once everything worked), revoke older gork tokens if asked, delete the setup
// token, and then start gork in the background while the page follows it.
import { loadConfig, SettingsError } from "../../src/config.ts";
import { renderEnv } from "../env-example.ts";
import { TOKENS_URL, type TokenSummary } from "./cloudflare-setup.ts";
import { EngineMissingError } from "./engine.ts";
import { type Privacy, realHost, writeEnvFile } from "./env-file.ts";
import { CliError } from "./errors.ts";
import { removeToken } from "./setup-cleanup.ts";
import type { SessionCore } from "./setup-core.ts";
import { ENV_HEADER, fresh, OUT_OF_ORDER, parseEnvText, TAIL_LINES, type View } from "./setup-state.ts";
import { printable } from "./text.ts";

export async function finish(core: SessionCore, input: { revokeOld?: unknown } = {}): Promise<View> {
  const c = core.requireChoices();
  const picked = core.discord.selected;
  const cf = core.cf;
  if (!picked || cf.phase !== "ready") throw new CliError(`Finish the Cloudflare step first. ${OUT_OF_ORDER}`);
  if (core.done.written) return core.view();
  const revoke = input.revokeOld === true && cf.older.length > 0;
  const stages = [
    "Checking your answers",
    "Saving your settings",
    ...(revoke ? ["Revoking older keys"] : []),
    "Deleting the one-time setup token",
  ];
  core.begin("finish", stages);
  const name = core.envName;
  const mark = core.notes.length;
  const values = {
    DISCORD_TOKEN: core.discord.token,
    GUILD_IDS: picked.map((g) => g.id).join(","),
    PERSONA: c.persona,
    MENTIONS: c.mentions,
    TIMEZONE: c.timezone,
    CF_ACCOUNT_ID: cf.accountId,
    CF_RUN_TOKEN: cf.runToken,
    CF_ADMIN_TOKEN: cf.adminToken,
    AI_GATEWAY_ID: cf.gatewayId,
    BILLING_MODE: c.billing,
    ...(c.billing === "credits" ? { DAILY_BUDGET_USD: c.budget } : {}),
  };
  core.book.check();
  let privacy: Privacy;
  let body: string;
  try {
    loadConfig(values);
    core.reach(1);
    body = renderEnv(values, ENV_HEADER);
    // Temp file, then a link into place: fails if .env appeared since the start, and never leaves a partial file.
    privacy = writeEnvFile(core.deps.envPath, body, core.deps.host ?? realHost());
  } catch (err) {
    const message =
      err instanceof SettingsError
        ? `the answers don't make a valid config: ${err.message}`
        : (err as NodeJS.ErrnoException).code === "EEXIST"
          ? `${name} already exists (it appeared while setup was running), so setup left it alone and wrote nothing`
          : `couldn't write ${name}: ${(err as Error).message}`;
    core.takingBack();
    await core.book.unwind(core.io()).catch(() => {});
    core.cf = {
      ...fresh.cf(cf.keepAdmin),
      failure: core.redact(message),
      failureNotes: core.notes.slice(mark),
      needNewToken: true,
    };
    throw new CliError(message);
  }
  core.env = parseEnvText(body);
  core.book.commit();
  if (revoke) core.reach(2);
  const oldTokens = input.revokeOld === true ? await revokeOlder(core, cf.accountId, cf.older) : null;
  core.reach(stages.length - 1);
  const gone = await core.book.removeBootstrap(core.io());
  core.done = {
    written: true,
    privacy,
    notes: core.notes.slice(mark),
    setupToken: gone === "deleted" ? "deleted" : "still-active",
    oldTokens,
  };
  return core.view();
}

/** Revokes the older gork tokens with the setup token (so before it is deleted) and reports exactly what happened. */
async function revokeOlder(
  core: SessionCore,
  accountId: string,
  older: TokenSummary[],
): Promise<{ revoked: number; left: string[] } | null> {
  const boot = core.book.bootstrap;
  if (older.length === 0 || !boot) return null;
  let revoked = 0;
  const left: string[] = [];
  for (const t of older) {
    const r = await removeToken(core.deps.fetch, boot.token, { kind: "account", accountId, id: t.id });
    if (r.status === "removed") revoked++;
    else left.push(`Still there: "${printable(t.name)}" (id ${printable(t.id, 40)}): ${r.detail}`);
  }
  if (revoked) core.note(`  Revoked ${revoked} older gork token${revoked === 1 ? "" : "s"}.`);
  for (const line of left) core.note(`  ${line}`);
  if (left.length) core.note(`  Delete ${left.length === 1 ? "it" : "them"} yourself: ${TOKENS_URL}`);
  return { revoked, left };
}

/** Starts gork in the background (the page follows it through the view) and answers at once. */
export function startBot(core: SessionCore): View {
  core.assertOpen();
  if (!core.done.written) throw new CliError(`The settings file isn't written yet. ${OUT_OF_ORDER}`);
  if (core.start.status === "running" || core.start.status === "online") return core.view();
  core.start = { ...fresh.start(), status: "running" };
  core.running = runStart(core);
  return core.view();
}

async function runStart(core: SessionCore): Promise<void> {
  const keep = (list: string[], line: string, max: number) => {
    list.push(core.redact(line).slice(0, 300));
    if (list.length > max) list.splice(0, list.length - max);
  };
  try {
    await core.deps.startBot(core.env, {
      step: (t) => keep(core.start.steps, t, TAIL_LINES),
      output: (l) => keep(core.start.tail, l, TAIL_LINES),
      warn: (l) => keep(core.start.steps, `Warning: ${l}`, TAIL_LINES),
    });
    core.start.status = "online";
  } catch (err) {
    if (err instanceof EngineMissingError) {
      core.start.status = "docker";
      core.start.message = core.redact(err.message);
    } else if (err instanceof CliError || err instanceof SettingsError) {
      core.start.status = "failed";
      core.start.message = core.redact(err.message);
    } else {
      core.start.status = "failed";
      core.start.message = "Something unexpected went wrong while starting gork. Run `npm run logs` to see.";
    }
  }
}
