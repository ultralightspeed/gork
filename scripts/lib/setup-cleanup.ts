// What setup has created (the gateway, the two tokens, the setup token) and how it takes them back on a failure, on
// Ctrl-C and at the end. Each removal is checked; what couldn't be removed is listed with a link. Nothing here prints a
// secret.
import {
  BOOTSTRAP_NAME,
  GATEWAYS_URL,
  revokeToken,
  TOKENS_URL,
  type TokenKind,
  type TokenRef,
  tokenState,
} from "./cloudflare-setup.ts";
import { CliError } from "./errors.ts";
import { type Api, deleteGateway } from "./gateway.ts";

interface CleanupIo {
  print(line: string): void;
  fetch: typeof fetch;
}

type Minted = { name: string; id: string; value: string };
type Bootstrap = { token: string; accountId: string; id: string; kind: TokenKind };

/**
 * "removed": gone, as far as can be told. "failed": the delete was refused. "survived": the delete went through but the
 * token still works. "unconfirmed": deleted, but nothing proves it stopped working.
 */
type Removal = { status: "removed" | "failed" | "survived" | "unconfirmed"; detail: string };

/**
 * Deletes a token with `auth` and checks the result. With `subject` (the token's own secret) it verifies it again and
 * only calls the token removed on a 401; without one it can only go by what the delete answered.
 */
export async function removeToken(
  fetchFn: typeof fetch,
  auth: string,
  ref: TokenRef,
  subject?: string,
): Promise<Removal> {
  let result: "deleted" | "missing" | null = null;
  let error = "";
  try {
    result = await revokeToken(auth, fetchFn, ref);
  } catch (err) {
    error = err instanceof CliError ? err.message : "the request failed";
  }
  if (subject) {
    const state = await tokenState(subject, fetchFn, ref.kind, ref.accountId);
    if (state === "revoked") return { status: "removed", detail: "" };
    if (state === "active") {
      return error
        ? { status: "failed", detail: error }
        : { status: "survived", detail: "it still works after the delete" };
    }
    return { status: "unconfirmed", detail: error || "couldn't confirm it stopped working" };
  }
  if (result === "deleted") return { status: "removed", detail: "" };
  if (result === "missing") return { status: "removed", detail: "it was already gone" };
  return { status: "failed", detail: error };
}

export class Ledger {
  bootstrap: Bootstrap | null = null;
  minted: Minted[] = [];
  /** The gateway THIS run created (never one that already existed) and a handle that can delete it. */
  private gateway: { api: Api; id: string } | null = null;
  /** The .env is written: the minted tokens and the gateway are now in use and must stay. */
  private committed = false;
  /** Ctrl-C was pressed: setup must stop at its next checkpoint. */
  interrupted = false;
  private inflight: Promise<unknown> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private bootstrapDone = false;

  setBootstrap(b: Bootstrap): void {
    this.bootstrap = b;
    this.bootstrapDone = false;
  }

  addMinted(t: Minted): void {
    this.minted.push(t);
  }

  setGateway(api: Api, id: string): void {
    this.gateway = { api, id };
  }

  /** From now on a cleanup keeps the minted tokens and the gateway, and only takes back the setup token. */
  commit(): void {
    this.committed = true;
  }

  /** Throws at a checkpoint after Ctrl-C, so setup stops instead of creating more. */
  check(): void {
    if (this.interrupted) throw new CliError("interrupted");
  }

  /** Runs `work` (a call that creates something), so a cleanup waits for it and sees what it made. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    const p = work();
    this.inflight = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  /** Removes everything this run made that is not committed, one at a time, and takes back the setup token. */
  unwind(io: CleanupIo): Promise<void> {
    const run = this.tail.then(() => this.doUnwind(io));
    this.tail = run.catch(() => {});
    return run;
  }

  /** The Ctrl-C handler: first press cleans up and exits 130; a second press exits at once. */
  async interrupt(io: CleanupIo & { exit?: (code: number) => void }): Promise<void> {
    if (this.interrupted) {
      io.print("Stopping now. Anything not yet cleaned up is named above.");
      io.exit?.(130);
      return;
    }
    this.interrupted = true;
    io.print("");
    io.print("Interrupted. Taking back what setup created (press Ctrl-C again to stop right away)...");
    await this.unwind(io);
    io.exit?.(130);
  }

  private async doUnwind(io: CleanupIo): Promise<void> {
    await this.inflight;
    if (!this.committed) {
      await this.removeGateway(io);
      await this.removeMinted(io);
    }
    await this.removeBootstrap(io);
  }

  private async removeGateway(io: CleanupIo): Promise<void> {
    const g = this.gateway;
    this.gateway = null;
    if (!g) return;
    try {
      await deleteGateway(g.api, g.id);
      io.print(`  Deleted the AI Gateway "${g.id}" that setup created.`);
    } catch (err) {
      io.print(
        `  Couldn't delete the AI Gateway "${g.id}" that setup created (${err instanceof CliError ? err.message : "the request failed"}). Delete it yourself: ${GATEWAYS_URL}`,
      );
    }
  }

  private async removeMinted(io: CleanupIo): Promise<void> {
    const todo = this.minted.splice(0);
    const boot = this.bootstrap;
    if (todo.length === 0) return;
    const gone: string[] = [];
    const left: string[] = [];
    for (const t of todo) {
      const r = boot
        ? await removeToken(io.fetch, boot.token, { kind: "account", accountId: boot.accountId, id: t.id }, t.value)
        : { status: "failed" as const, detail: "no setup token to delete it with" };
      if (r.status === "removed") gone.push(t.name);
      else {
        const why = r.status === "unconfirmed" ? `not confirmed removed: ${r.detail}` : r.detail;
        left.push(`  Still active: "${t.name}" (id ${t.id}): ${why}`);
      }
    }
    if (gone.length) io.print(`  Removed the tokens setup created (${gone.join(", ")}).`);
    if (left.length) {
      for (const line of left) io.print(line);
      io.print(`  Delete ${left.length === 1 ? "it" : "them"} yourself: ${TOKENS_URL}`);
    }
  }

  /**
   * Deletes the setup token and says truthfully how that went. Safe to call more than once. Returns "deleted" only
   * when Cloudflare stopped accepting the token, "still-active" when it may still work, and "none" when there was
   * no setup token (or it was already dealt with).
   */
  async removeBootstrap(io: CleanupIo): Promise<"deleted" | "still-active" | "none"> {
    const b = this.bootstrap;
    if (!b || this.bootstrapDone) return "none";
    this.bootstrapDone = true;
    const link = `delete "${BOOTSTRAP_NAME}" yourself: ${TOKENS_URL}`;
    if (!b.id) {
      io.print(`  Couldn't delete the setup token (its id couldn't be read). It is still active: ${link}`);
      return "still-active";
    }
    const r = await removeToken(io.fetch, b.token, { kind: b.kind, accountId: b.accountId, id: b.id }, b.token);
    if (r.status === "removed") {
      io.print(`  Deleted the setup token (${BOOTSTRAP_NAME}), so nothing powerful stays around.`);
      return "deleted";
    }
    if (r.status === "failed") {
      io.print(`  Couldn't delete the setup token (${r.detail}). It is still active: ${link}`);
    } else if (r.status === "survived") {
      io.print(`  Cloudflare was asked to delete the setup token, but it still works. It is still active: ${link}`);
    } else {
      io.print(`  Deleted the setup token, but couldn't confirm it stopped working (${r.detail}). Check it: ${link}`);
    }
    return "still-active";
  }
}
