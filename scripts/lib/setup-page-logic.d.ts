// Types for setup-page-logic.js, which stays plain JavaScript because it is put into the setup page as is.
import type { View } from "./setup-session.ts";

export type Hint = { level: "" | "ok" | "bad"; text: string };
/** The page's own state, beside the server's view. */
export type PageState = { stopped?: boolean; lost?: boolean; pending?: string | null; acked?: boolean };
export type CardState = "done" | "active" | "locked";
export type Line = { ok: boolean; warn?: boolean; text: string };

export function safeHref(url: unknown): string | null;
export function codeParts(text: string): { text: string; code: boolean }[];
export function secretHint(kind: "discord" | "cloudflare", value: string): Hint;
export function nameHint(name: string): Hint;
export function charactersLeft(value: string, limit: number): Hint;
export function gatewayPreview(name: string, gateway: { id: string } | null): Hint & { ok: boolean };
export function isClosedAnswer(status: number): boolean;
export function closedMeansLost(view: View | null, stopped: boolean): boolean;
export function pollKind(view: View | null, ui: PageState): { path: string; every: number } | null;
export function cardState(
  view: View,
  ui: { editingChoices?: boolean; acked?: boolean },
): Record<"choices" | "discord" | "cloudflare" | "finish", CardState>;
export function workOf(view: View, pending: string | null, id: string): View["work"];
export function choicesSummary(choices: NonNullable<View["choices"]>): string;
export function advancedChanged(choices: NonNullable<View["choices"]>, zone: string): boolean;
export function customWarnings(view: View): string[];
export function discordWaiting(discord: View["discord"], what: "public" | "invite"): string;
export function probeLine(probe: View["cloudflare"]["probes"][number]): { ok: boolean; name: string; detail: string };
export function finishLines(view: View): Line[];
