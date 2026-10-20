// The setup session's state and what every step shares: one step at a time, the page's polls, progress and redaction.
import { basename } from "node:path";
import { listPersonas, loadPersona } from "../../src/persona.ts";
import { type CustomDraft, loadDraft } from "./custom-persona.ts";
import type { Application } from "./discord-setup.ts";
import { CliError } from "./errors.ts";
import { Ledger } from "./setup-cleanup.ts";
import {
  type Choices,
  fresh,
  OUT_OF_ORDER,
  type SetupDeps,
  TAKING_BACK,
  type View,
  type WorkId,
} from "./setup-state.ts";
import { buildView } from "./setup-view.ts";
import { printable } from "./text.ts";

export class SessionCore {
  deps: SetupDeps;
  book = new Ledger();
  choices: Choices | null = null;
  discord = fresh.discord();
  cf = fresh.cf();
  done = fresh.finish();
  start = fresh.start();
  /** What was written to .env, for starting gork with it. */
  env: Record<string, string> = {};
  notes: string[] = [];
  busy = false;
  working: { id: WorkId; labels: string[]; at: number } | null = null;
  /** A page poll in flight: steps wait for it, and a poll never starts while a step runs. */
  polling: Promise<void> | null = null;
  /** The step in flight (settled, never rejected), so stopping can wait for it. */
  current: Promise<unknown> = Promise.resolve();
  closed = false;
  personas: { name: string; description: string }[];
  customDraft: CustomDraft;
  customWarnings: string[] = [];
  /** The example's [bracketed parts]: a body that still has them hasn't been written yet. */
  placeholders: string[];
  /** The background startup, so a caller (and the tests) can wait for it. */
  running: Promise<void> = Promise.resolve();

  constructor(deps: SetupDeps) {
    this.deps = deps;
    this.personas = readPersonas(deps.personasDir);
    const start = loadDraft(deps.personasDir);
    this.customDraft = start.draft;
    this.placeholders = start.placeholders;
  }

  get envName(): string {
    return basename(this.deps.envPath);
  }

  view(): View {
    return buildView(this);
  }

  /** What the Ledger prints through. Built fresh so a replaced `fetch` is always the one used. */
  io() {
    return { print: (line: string) => this.note(line), fetch: this.deps.fetch, exit: this.deps.exit };
  }

  note(line: string): void {
    const clean = this.redact(line);
    this.notes.push(clean);
    this.deps.print?.(clean);
  }

  /** Every secret this session holds, longest first. */
  private secrets(): string[] {
    return [this.discord.token, this.cf.token, this.cf.runToken, this.cf.adminToken, this.book.bootstrap?.token ?? ""]
      .filter((s) => s.length >= 8)
      .sort((a, b) => b.length - a.length);
  }

  /** The text with any secret the session knows replaced, for anything that came from outside (build output, errors). */
  redact(value: string): string {
    let out = value;
    for (const secret of this.secrets()) out = out.replaceAll(secret, "[hidden]");
    return out;
  }

  assertOpen(): void {
    if (this.closed) throw new CliError("Setup has stopped. Run `npm run setup` again to start over.");
  }

  /** One step at a time: a second call while one runs is refused, so a double click can't create two sets of tokens. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    // The page asks "anything new?" every few seconds; a click that lands in the middle of that waits for it.
    while (this.polling) await this.polling;
    this.assertOpen();
    if (this.busy) throw new CliError("Still working on the last step. Wait a moment, then try again.");
    this.busy = true;
    const run = work();
    this.current = run.then(
      () => {},
      () => {},
    );
    try {
      const result = await run;
      // The view a step hands back was made while it was still running: it must not say it still is.
      this.working = null;
      return (result && typeof result === "object" && "work" in result ? { ...result, work: null } : result) as T;
    } finally {
      this.busy = false;
      this.working = null;
    }
  }

  /** A poll from the page: skipped (answering with the current view) when anything else is running. */
  async polled(work: () => Promise<View>): Promise<View> {
    this.assertOpen();
    if (this.busy || this.polling) return this.view();
    let done!: () => void;
    this.polling = new Promise<void>((resolve) => {
      done = resolve;
    });
    try {
      return await work();
    } finally {
      this.polling = null;
      done();
    }
  }

  /** The step now running, as a list of what it does (shown by the page). Cleared whenever a step ends. */
  begin(id: WorkId, labels: string[], at = 0): void {
    this.working = { id, labels, at };
  }

  /** The running step has got to its `at`th stage. */
  reach(at: number): void {
    if (this.working) this.working.at = at;
  }

  /** What the page shows while things made at Cloudflare are being taken back. */
  takingBack(): void {
    this.begin("cloudflare", [TAKING_BACK]);
  }

  /** The Cloudflare stages, worded for the billing mode (free mode has no web search to test). */
  cloudflareStages(): string[] {
    const free = this.choices?.billing === "free";
    return [
      "Finding your account",
      "Making gork's keys",
      "Setting up the AI Gateway",
      free ? "Testing chat, page reading" : "Testing chat, page reading, web search",
    ];
  }

  requireChoices(): Choices {
    if (!this.choices) throw new CliError(`Answer the questions in step 1 first. ${OUT_OF_ORDER}`);
    return this.choices;
  }

  requireApp(): Application {
    if (!this.discord.app) throw new CliError("Paste the Discord bot token first.");
    return this.discord.app;
  }

  requireServer(): void {
    this.requireChoices();
    if (!this.discord.selected) throw new CliError("Add gork to your Discord server and confirm it first.");
  }
}

/** The presets to offer (custom last), each with its one-line description. */
function readPersonas(personasDir: string): { name: string; description: string }[] {
  let names: string[] = [];
  try {
    names = listPersonas(personasDir).filter((n) => n !== "custom");
  } catch {
    /* no folder: only custom is offered */
  }
  const rows = names.map((name) => {
    let description = "";
    try {
      description = printable(loadPersona(personasDir, name).description, 100);
    } catch {
      /* a preset that won't load is listed without a description */
    }
    return { name, description };
  });
  return [...rows, { name: "custom", description: "your own: write it right here" }];
}
