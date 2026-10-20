// What the setup page may see: built field by field from the session's state, never the state itself, so a secret
// (the Discord token, the setup token, the two new tokens) can't reach the page by accident.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bootstrapLink, CREDITS_URL, TOKENS_URL } from "./cloudflare-setup.ts";
import { CUSTOM_FILE, CUSTOM_LIMITS, REPLY_FIELDS } from "./custom-persona.ts";
import { CREATE_APP_URL, inviteUrl } from "./discord-setup.ts";
import { DOCKER_DESKTOP_URL, PODMAN_DESKTOP_URL } from "./engine.ts";
import type { SessionCore } from "./setup-core.ts";
import { NOTE_LINES, suggestGatewayName, type View } from "./setup-state.ts";
import { printable } from "./text.ts";

/** Everything the page may know, built field by field from the session's state, so no secret can come along. */
export function buildView(core: SessionCore): View {
  const c = core.choices;
  const d = core.discord;
  const cf = core.cf;
  const picked = d.selected;
  const step = !c ? "choices" : !picked ? "discord" : cf.phase !== "ready" ? "cloudflare" : "finish";
  const invite = c && d.app ? inviteUrl(d.app.id, { mentionEveryone: c.mentionsEveryone }) : null;
  // Messages that came from Discord or Cloudflare are redacted too, in case one ever quotes a token back.
  const r = <T extends string | null>(text: T): T => (text === null ? text : (core.redact(text) as T));
  return {
    envName: core.envName,
    envExists: existsSync(core.deps.envPath),
    step,
    options: { personas: core.personas.map((p) => ({ ...p })) },
    custom: {
      exists: existsSync(join(core.deps.personasDir, CUSTOM_FILE)),
      draft: { ...core.customDraft, replies: { ...core.customDraft.replies } },
      warnings: [...core.customWarnings],
      replyFields: REPLY_FIELDS.map((f) => ({ ...f })),
      limits: { ...CUSTOM_LIMITS },
    },
    links: {
      discordApp: CREATE_APP_URL,
      discordApps: "https://discord.com/developers/applications",
      cloudflareToken: bootstrapLink(),
      cloudflareSignup: "https://dash.cloudflare.com/sign-up",
      tokens: TOKENS_URL,
      credits: CREDITS_URL,
      docker: DOCKER_DESKTOP_URL,
      podman: PODMAN_DESKTOP_URL,
    },
    choices: c ? { ...c } : null,
    discord: {
      app: d.app ? { name: d.appName } : null,
      intent: d.intent ? { ok: d.intent.ok, message: r(d.intent.message) } : null,
      publicBot: d.publicBot,
      inviteUrl: invite,
      guilds: d.guilds ? d.guilds.map((g) => ({ ...g })) : null,
      guildsProblem: r(d.guildsProblem),
      problem: r(d.problem),
      selected: picked ? picked.map((g) => ({ ...g })) : null,
    },
    cloudflare: {
      phase: cf.phase,
      accounts: cf.accounts ? cf.accounts.map((a) => ({ id: a.id, name: printable(a.name) })) : null,
      accountProblem: r(cf.accountProblem),
      gateway: cf.conflict
        ? { id: cf.conflict.id, summary: [...cf.conflict.summary], suggestion: suggestGatewayName(cf.conflict.id) }
        : null,
      older: cf.older.map((t) => ({ id: printable(t.id, 40), name: printable(t.name) })),
      olderProblem: r(cf.olderProblem),
      probes: cf.probes.map((p) => ({
        capability: p.capability,
        ok: p.ok,
        message: r(p.message),
        ...(p.kind ? { kind: p.kind } : {}),
      })),
      needsCredits: c?.billing === "credits" && cf.probes.some((p) => p.kind === "credits"),
      failure: r(cf.failure),
      failureNotes: cf.failureNotes.map(r),
      needNewToken: cf.needNewToken,
    },
    finish: {
      ...core.done,
      notes: [...core.done.notes],
      oldTokens: core.done.oldTokens && { ...core.done.oldTokens },
    },
    start: {
      ...core.start,
      steps: [...core.start.steps],
      tail: [...core.start.tail],
      servers: (picked ?? []).map((g) => g.name || `server ${g.id}`),
    },
    work: core.working && {
      id: core.working.id,
      steps: core.working.labels.map((label, i) => {
        const at = (core.working as { at: number }).at;
        return { label, state: i < at ? "done" : i === at ? "active" : "todo" };
      }),
    },
    notes: core.notes.slice(-NOTE_LINES),
  };
}
