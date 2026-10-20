// One SetupSession per `npm run setup`: a method for each thing the page asks, and view(), which is all the page sees.
// The steps are in setup-step-*.ts, the shared state and plumbing in setup-core.ts, the view in setup-view.ts.
import { SessionCore } from "./setup-core.ts";
import type { ChoicesInput, SetupDeps, View } from "./setup-state.ts";
import { saveChoices } from "./setup-step-choices.ts";
import {
  cloudflareAccount,
  cloudflareReset,
  cloudflareToken,
  creditsRecheck,
  gatewayChoice,
} from "./setup-step-cloudflare.ts";
import { confirmServers, discordRefresh, discordToken } from "./setup-step-discord.ts";
import { finish, startBot } from "./setup-step-finish.ts";

export type { SetupDeps, View } from "./setup-state.ts";
export { parseEnvText, suggestGatewayName } from "./setup-state.ts";

export class SetupSession {
  private core: SessionCore;

  constructor(deps: SetupDeps) {
    this.core = new SessionCore(deps);
  }

  /** The session's outside world. Every step reads it when it runs, so a replaced one (or field) is used from then on. */
  get deps(): SetupDeps {
    return this.core.deps;
  }

  set deps(deps: SetupDeps) {
    this.core.deps = deps;
  }

  /** The background startup, so a caller (and the tests) can wait for it. */
  get running(): Promise<void> {
    return this.core.running;
  }

  /** The text with any secret the session knows replaced, for anything that came from outside (build output, errors). */
  redact(value: string): string {
    return this.core.redact(value);
  }

  isDone(): boolean {
    return this.core.start.status === "online";
  }

  view(): View {
    return this.core.view();
  }

  // ---- step 1: choices ----

  saveChoices(input: ChoicesInput): Promise<View> {
    return this.core.exclusive(() => saveChoices(this.core, input));
  }

  // ---- step 2: Discord ----

  discordToken(raw: unknown): Promise<View> {
    return this.core.exclusive(() => discordToken(this.core, raw));
  }

  /** A poll from the page: is Public Bot off yet, and has the bot joined a server? */
  discordRefresh(): Promise<View> {
    return this.core.polled(() => discordRefresh(this.core));
  }

  confirmServers(ids: unknown, manualId?: unknown): Promise<View> {
    return this.core.exclusive(() => confirmServers(this.core, ids, manualId));
  }

  // ---- step 3: Cloudflare ----

  cloudflareToken(raw: unknown, keepAdmin: unknown = true): Promise<View> {
    return this.core.exclusive(() => cloudflareToken(this.core, raw, keepAdmin));
  }

  cloudflareAccount(pick: unknown): Promise<View> {
    return this.core.exclusive(() => cloudflareAccount(this.core, pick));
  }

  gatewayChoice(input: { action?: unknown; newId?: unknown }): Promise<View> {
    return this.core.exclusive(() => gatewayChoice(this.core, input));
  }

  /** A poll from the page while it waits for credits. */
  creditsRecheck(): Promise<View> {
    return this.core.polled(() => creditsRecheck(this.core));
  }

  cloudflareReset(): Promise<View> {
    return this.core.exclusive(() => cloudflareReset(this.core));
  }

  // ---- step 4: finish, then start gork ----

  finish(input: { revokeOld?: unknown } = {}): Promise<View> {
    return this.core.exclusive(() => finish(this.core, input));
  }

  /** Starts gork in the background and answers at once; the page follows it through the view. */
  async startBot(): Promise<View> {
    return startBot(this.core);
  }

  // ---- stopping ----

  /** Ctrl-C: takes back what was made, then ends the process. A second Ctrl-C ends it at once. */
  async interrupt(): Promise<void> {
    await this.core.book.interrupt(this.core.io());
  }

  /** The page was abandoned (idle too long) or setup is over: takes back anything not yet kept, and answers nothing more. */
  async dispose(): Promise<void> {
    const core = this.core;
    core.closed = true;
    // A step still running must not go on making things after the clean-up: it stops at its next checkpoint, and the
    // clean-up waits for it (but not forever: a request that never answers must not keep setup, and its tokens, open).
    core.book.interrupted = true;
    const limit = new Promise<void>((resolve) => setTimeout(resolve, core.deps.settleMs ?? 20_000).unref());
    await Promise.race([Promise.all([core.current, core.polling]), limit]);
    await core.book.unwind(core.io());
  }
}
