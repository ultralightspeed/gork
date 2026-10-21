// Step 3 of setup: the one-time setup token, the account, gork's two tokens, the AI Gateway and the checks of what the
// run token can do. Everything made here is tracked in the session's Ledger and taken back on any failure.
import { CREDITS_MODEL, FREE_MODEL, SETTINGS } from "../../src/config.ts";
import {
  AccountsUnlistedError,
  ADMIN_NEEDS,
  expiresIn,
  listAccounts,
  listAccountTokens,
  listPermissionGroups,
  looksLikeCloudflareToken,
  mintToken,
  parseAccountId,
  probeRunToken,
  resolvePermissionGroups,
  runNeeds,
  TokenRejectedError,
  verifyToken,
} from "./cloudflare-setup.ts";
import { CliError } from "./errors.ts";
import { type Api, cloudflareApi, ensureGateway, gatewaySummary, readGateway } from "./gateway.ts";
import type { SessionCore } from "./setup-core.ts";
import {
  ADMIN_LIFETIME_MS,
  CREDITS_GAP_MS,
  fresh,
  OUT_OF_ORDER,
  OWN_TOKEN_NAMES,
  text,
  type View,
} from "./setup-state.ts";

export async function cloudflareToken(core: SessionCore, raw: unknown, keepAdmin: unknown = true): Promise<View> {
  core.requireServer();
  if (core.cf.phase !== "token" || core.cf.token) {
    throw new CliError(
      "Cloudflare setup is already under way in another tab. Finish it there, or stop setup and run it again.",
    );
  }
  const token = text(raw) ?? "";
  if (!token) throw new TokenRejectedError("Paste the setup token into the box first.");
  if (!looksLikeCloudflareToken(token)) {
    throw new TokenRejectedError(
      "That doesn't look like a Cloudflare API token (they have no dots or spaces). A Discord token or something else may have been pasted here. Copy the secret Cloudflare shows after Create Token.",
    );
  }
  core.cf = { ...fresh.cf(keepAdmin !== false), token };
  core.begin("cloudflare", core.cloudflareStages());
  // From here the token may be live at Cloudflare, so a failure or Ctrl-C must try to delete it.
  core.book.setBootstrap({ token, accountId: "", id: "", kind: "account" });
  try {
    const accounts = await listAccounts(token, core.deps.fetch);
    if (accounts.length > 1) {
      core.cf.accounts = accounts;
      core.cf.phase = "account";
      return core.view();
    }
    await runCloudflare(core, accounts[0].id);
  } catch (err) {
    if (err instanceof AccountsUnlistedError) {
      core.cf.phase = "account";
      core.cf.accountProblem = err.message;
      return core.view();
    }
    if (err instanceof TokenRejectedError) {
      // Cloudflare itself says the token is no good: nothing to take back, and the next paste starts clean.
      core.book.bootstrap = null;
      core.cf = fresh.cf();
      throw err;
    }
    return failCloudflare(core, err);
  }
  return core.view();
}

export async function cloudflareAccount(core: SessionCore, pick: unknown): Promise<View> {
  core.requireServer();
  const cf = core.cf;
  if (cf.phase !== "account") throw new CliError(`There is no account question to answer yet. ${OUT_OF_ORDER}`);
  const wanted = text(pick) ?? "";
  let id: string | null;
  core.begin("cloudflare", core.cloudflareStages());
  if (cf.accounts) {
    id = cf.accounts.find((a) => a.id === wanted.toLowerCase())?.id ?? null;
    if (!id) throw new CliError("Pick one of the accounts in the list.");
  } else {
    id = parseAccountId(wanted);
    if (!id)
      throw new CliError(
        "There is no 32-character account ID in that. Paste the address of your Cloudflare dashboard.",
      );
  }
  try {
    await runCloudflare(core, id);
  } catch (err) {
    return failCloudflare(core, err);
  }
  return core.view();
}

/** Takes back what a failed or stopped Cloudflare step made, and sends the page back to asking for a setup token. */
async function failCloudflare(core: SessionCore, err: unknown): Promise<never> {
  const mark = core.notes.length;
  core.takingBack();
  await core.book.unwind(core.io());
  const message = err instanceof CliError ? err.message : "Something unexpected went wrong.";
  core.cf = {
    ...fresh.cf(core.cf.keepAdmin),
    failure: core.redact(message),
    failureNotes: core.notes.slice(mark),
    needNewToken: true,
  };
  throw err;
}

/** Looks up older tokens, makes gork's two, and goes on to the gateway. Throws on any failure; the caller cleans up. */
async function runCloudflare(core: SessionCore, accountId: string): Promise<void> {
  const c = core.requireChoices();
  const cf = core.cf;
  const fetchFn = core.deps.fetch;
  cf.accountId = accountId;
  const bootstrap = cloudflareApi(accountId, cf.token, fetchFn);
  let info = null;
  try {
    info = await verifyToken(cf.token, fetchFn, accountId);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
  }
  core.book.setBootstrap({ token: cf.token, accountId, id: info?.id ?? "", kind: info?.kind ?? "account" });
  core.book.check();

  try {
    cf.older = (await listAccountTokens(bootstrap)).filter((t) => OWN_TOKEN_NAMES.includes(t.name));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    cf.olderProblem = `Couldn't check for older gork tokens (${err.message}). If you have run setup before, look for old "gork-run" and "gork-admin" tokens in your Cloudflare account.`;
  }
  core.book.check();

  core.reach(1);
  const groups = await listPermissionGroups(bootstrap);
  resolvePermissionGroups(groups, [...runNeeds(c.billing), ...ADMIN_NEEDS]);
  const ids = (needs: Parameters<typeof resolvePermissionGroups>[1]) =>
    resolvePermissionGroups(groups, needs).map((g) => g.id);
  const mint = (name: string, needs: Parameters<typeof resolvePermissionGroups>[1], expiresOn?: string) =>
    core.book.track(async () => {
      const t = await mintToken(bootstrap, accountId, name, ids(needs), { expiresOn });
      core.book.addMinted({ name, id: t.id, value: t.value });
      return t;
    });
  core.book.check();
  const run = await mint("gork-run", runNeeds(c.billing));
  cf.runToken = run.value;
  core.book.check();
  const admin = await mint(
    "gork-admin",
    ADMIN_NEEDS,
    cf.keepAdmin ? undefined : expiresIn(ADMIN_LIFETIME_MS, core.deps.now()),
  );
  cf.adminToken = admin.value;
  core.book.check();
  core.note("Created the gork-run and gork-admin tokens.");
  cf.adminApi = cloudflareApi(accountId, admin.value, fetchFn);
  core.reach(2);
  await gatewayFor(core, SETTINGS.AI_GATEWAY_ID.default);
}

/** Makes the gateway, or (when one with that id already exists) stops and shows it, changing nothing. */
async function gatewayFor(core: SessionCore, id: string): Promise<void> {
  const api = core.cf.adminApi as Api;
  const existing = await readGateway(api, id);
  core.book.check();
  if (existing) {
    core.cf.conflict = { id, summary: gatewaySummary(existing) };
    core.cf.phase = "gateway";
    return;
  }
  await makeGateway(core, id);
}

async function makeGateway(core: SessionCore, id: string): Promise<void> {
  const c = core.requireChoices();
  const cf = core.cf;
  const api = cf.adminApi as Api;
  const did = await core.book.track(async () => {
    const result = await ensureGateway(api, id, Number(c.budget), c.billing);
    if (result === "created") core.book.setGateway(api, id);
    return result;
  });
  core.book.check();
  const how = c.billing === "free" ? "standard" : "credits";
  core.note(
    did === "unchanged"
      ? `AI Gateway "${id}" already had gork's settings (${how} billing); left as it is.`
      : `${did === "created" ? "Created" : "Updated"} AI Gateway "${id}" (${how} billing).`,
  );
  cf.gatewayId = id;
  cf.conflict = null;
  core.reach(3);
  cf.probes = await probeRunToken(probeOptions(core), core.deps.fetch);
  core.book.check();
  cf.phase = "ready";
}

function probeOptions(core: SessionCore, search = true) {
  const c = core.requireChoices();
  return {
    accountId: core.cf.accountId,
    token: core.cf.runToken,
    gatewayId: core.cf.gatewayId,
    billing: c.billing,
    model: c.billing === "free" ? FREE_MODEL : CREDITS_MODEL,
    searchProvider: SETTINGS.SEARCH_PROVIDER.parse(SETTINGS.SEARCH_PROVIDER.default),
    search,
  };
}

export async function gatewayChoice(core: SessionCore, input: { action?: unknown; newId?: unknown }): Promise<View> {
  const cf = core.cf;
  const waiting = cf.phase === "gateway" ? cf.conflict : null;
  if (!waiting) throw new CliError(`There is no gateway question to answer yet. ${OUT_OF_ORDER}`);
  if (input.action === "cancel") {
    const mark = core.notes.length;
    core.takingBack();
    await core.book.unwind(core.io());
    core.cf = {
      ...fresh.cf(cf.keepAdmin),
      failure: `You chose to keep the AI Gateway "${waiting.id}" as it is, so setup stopped. Nothing of yours was changed, and the keys made for this setup were taken back.`,
      failureNotes: core.notes.slice(mark),
      needNewToken: true,
    };
    return core.view();
  }
  if (input.action !== "overwrite" && input.action !== "new") {
    throw new CliError("Choose overwrite, a different gateway id, or cancel.");
  }
  let id = waiting.id;
  if (input.action === "new") {
    try {
      id = SETTINGS.AI_GATEWAY_ID.parse(typeof input.newId === "string" ? input.newId.trim() : "");
    } catch (err) {
      throw new CliError(`Gateway id: ${(err as Error).message}`);
    }
    if (id.toLowerCase() === waiting.id.toLowerCase()) {
      throw new CliError(
        `You already have a gateway called "${waiting.id}": that is the one in the way. Type a different name, or use the first button to change that one.`,
      );
    }
  }
  core.begin("cloudflare", core.cloudflareStages(), 2);
  try {
    if (input.action === "new") await gatewayFor(core, id);
    else await makeGateway(core, id);
  } catch (err) {
    return failCloudflare(core, err);
  }
  return core.view();
}

/**
 * Called by the page every few seconds while it waits for credits. Looks again without spending money (no web search)
 * until the chat check passes, then runs the full set once more to refresh every result.
 */
export async function creditsRecheck(core: SessionCore): Promise<View> {
  const cf = core.cf;
  const waiting = cf.phase === "ready" && cf.probes.some((p) => p.kind === "credits");
  const now = core.deps.now();
  if (!waiting || now - cf.lastCredits < CREDITS_GAP_MS) return core.view();
  cf.lastCredits = now;
  const quick = await probeRunToken(probeOptions(core, false), core.deps.fetch);
  if (quick.some((p) => p.kind === "credits")) {
    cf.probes = cf.probes.map((p) => quick.find((q) => q.capability === p.capability) ?? p);
  } else {
    cf.probes = await probeRunToken(probeOptions(core, true), core.deps.fetch);
  }
  return core.view();
}

/** Takes back everything made for Cloudflare so far (tokens, a new gateway, the setup token) and starts that step over. */
export async function cloudflareReset(core: SessionCore): Promise<View> {
  if (!core.cf.token) return core.view();
  if (core.done.written) throw new CliError("Setup is finished; there is nothing to start over.");
  const mark = core.notes.length;
  core.takingBack();
  await core.book.unwind(core.io());
  core.cf = { ...fresh.cf(core.cf.keepAdmin), failureNotes: core.notes.slice(mark), needNewToken: true };
  return core.view();
}
