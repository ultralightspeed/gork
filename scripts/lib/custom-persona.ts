// The custom personality that setup's page lets a person write: what it accepts, the personas/custom.md it generates, and
// how that file is put in place. The page's fields are data, never file syntax: the front matter is generated here, every
// single-line value is flattened to one line (so a value can't add a key), and the body goes after the closing marker
// where `---` or `key: value` lines are just text. Whatever is written is checked by reading it back with parsePersona.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { PERSONA_REPLY_DEFAULTS, PERSONA_REPLY_KEYS, parsePersona, splitPersona } from "../../src/persona.ts";
import { CliError } from "./errors.ts";
import { printable } from "./text.ts";

/** The one file setup ever writes into the personas folder. */
export const CUSTOM_FILE = "custom.md";
const EXAMPLE_FILE = "custom.example.md";

export const CUSTOM_LIMITS = { name: 32, body: 8000, quirk: 300, reply: 300 } as const;
const DEFAULT_RATE = 30;
/** A custom.md bigger than this is not read at all (it can't be one this page wrote). */
const READ_LIMIT = 1024 * 1024;

/** What the page edits. `quirkRate` is a percentage from 0 to 100; `replies` is by front-matter key (`busy`, ...). */
export type CustomDraft = {
  name: string;
  body: string;
  quirk: string;
  quirkRate: number;
  replies: Record<string, string>;
};

const REPLY_LABELS: Record<string, string> = {
  blocked: "When gork refuses a request",
  out_of_budget: "When the daily budget is used up",
  busy: "When gork is still answering the last message",
  error: "When something breaks",
  empty: "When someone pings gork without a question",
  empty_answer: "When the AI comes back with no text",
  cooldown: "When someone must wait (write {seconds} for the wait)",
  no_attach: "Added when an image was made but files can't be uploaded here",
  no_poll: "Added when a poll was made but polls can't be posted here",
  no_event: "Added when an event was made but nobody here may create events",
  event_failed: "When Discord refused to create the event",
};

/** The fixed replies the page offers: the key, a label, and gork's built-in wording (shown as the placeholder). */
export const REPLY_FIELDS: { key: string; label: string; placeholder: string }[] = PERSONA_REPLY_KEYS.map((key) => ({
  key,
  label: REPLY_LABELS[key] ?? key,
  placeholder: PERSONA_REPLY_DEFAULTS[key] ?? "",
}));

const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.'’-]*$/u;
// Built from code points: a literal U+2028 or U+2029 in this file would itself be a line break.
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LINE_BREAKS = new RegExp(`[\r\n${NEL}${LS}${PS}]`, "g");
const BODY_BREAKS = new RegExp(`\r\n?|[${NEL}${LS}${PS}]`, "g");

const chars = (s: string) => [...s].length;
const cut = (s: string, max: number) => [...s].slice(0, max).join("");

/** One line of plain text: line breaks and tabs become spaces, control and direction-changing characters go. */
function oneLine(value: string): string {
  return printable(value.replace(LINE_BREAKS, " ").replace(/\t/g, " "), Number.POSITIVE_INFINITY)
    .replace(/\s+/g, " ")
    .trim();
}

/** The body: line endings made `\n`, control and direction-changing characters (except tabs and line breaks) removed. */
function bodyText(value: string): string {
  return [...value.replace(BODY_BREAKS, "\n")]
    .filter((ch) => ch === "\n" || ch === "\t" || printable(ch, 1) !== "")
    .join("")
    .trim();
}

const asText = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Checks what the page sent and returns it cleaned, with warnings (never fatal). Throws CliError with a plain reason. */
export function validateCustom(input: unknown): { draft: CustomDraft; warnings: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CliError("Fill in the custom personality first (a name, and how gork should talk).");
  }
  const raw = input as Record<string, unknown>;
  const warnings: string[] = [];

  const nameIn = asText(raw.name);
  if (nameIn === null) throw new CliError("The name must be text.");
  const name = nameIn.trim().replace(/ {2,}/g, " ");
  if (!name) throw new CliError("Give gork a name.");
  if (chars(name) > CUSTOM_LIMITS.name) {
    throw new CliError(`The name can be at most ${CUSTOM_LIMITS.name} characters.`);
  }
  if (!NAME_OK.test(name)) {
    throw new CliError(
      "The name can have letters, numbers, spaces and - _ . ' only, and must start with a letter or number.",
    );
  }

  const bodyIn = asText(raw.body);
  if (bodyIn === null) throw new CliError('Fill in "How should gork talk and behave?" with text.');
  const body = bodyText(bodyIn);
  if (!body) throw new CliError('Fill in "How should gork talk and behave?": it is what gork is told to be like.');
  if (chars(body) > CUSTOM_LIMITS.body) {
    throw new CliError(
      `"How should gork talk and behave?" can be at most ${CUSTOM_LIMITS.body.toLocaleString("en-US")} characters (it is ${chars(body).toLocaleString("en-US")}).`,
    );
  }

  let quirk = "";
  let quirkRate = 0;
  if (raw.quirk !== undefined && raw.quirk !== null) {
    const quirkIn = asText(raw.quirk);
    if (quirkIn === null) throw new CliError("The quirk must be text.");
    quirk = oneLine(quirkIn);
  }
  if (chars(quirk) > CUSTOM_LIMITS.quirk) {
    throw new CliError(`The quirk can be at most ${CUSTOM_LIMITS.quirk} characters.`);
  }
  if (quirk) {
    const given = typeof raw.quirkRate === "string" ? raw.quirkRate.trim() : raw.quirkRate;
    if (given === undefined || given === null || given === "") quirkRate = DEFAULT_RATE;
    else {
      const n = typeof given === "number" ? given : Number(given);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new CliError("How often the quirk happens must be a number between 0 and 100 (percent).");
      }
      quirkRate = Math.round(n);
    }
    if (quirkRate === 0) warnings.push("The quirk is set to 0%, so gork will never use it.");
  }

  const replies: Record<string, string> = {};
  if (raw.replies !== undefined && raw.replies !== null) {
    if (typeof raw.replies !== "object" || Array.isArray(raw.replies)) {
      throw new CliError("The fixed replies must be a list of replies.");
    }
    for (const [key, value] of Object.entries(raw.replies as Record<string, unknown>)) {
      if (!PERSONA_REPLY_KEYS.includes(key))
        throw new CliError(`Fixed replies: "${printable(key, 40)}" isn't one gork knows.`);
      if (value === undefined || value === null) continue;
      const text = asText(value);
      if (text === null) throw new CliError("Fixed replies must be text.");
      const line = oneLine(text);
      if (chars(line) > CUSTOM_LIMITS.reply) {
        throw new CliError(`The fixed reply for "${key}" can be at most ${CUSTOM_LIMITS.reply} characters.`);
      }
      if (line) replies[key] = line;
    }
  }

  const draft: CustomDraft = { name, body, quirk, quirkRate, replies };
  // What parsePersona makes of the file is what gork will run with: anything it complains about is shown.
  warnings.push(...parsePersona(renderCustom(draft), CUSTOM_FILE).warnings);
  return { draft, warnings };
}

/** The text of personas/custom.md for a draft. Values are flattened to one line, so none can add a key. */
export function renderCustom(draft: CustomDraft): string {
  const lines: string[] = [];
  const name = oneLine(draft.name);
  if (name) lines.push(`name: ${name}`);
  const quirk = oneLine(draft.quirk);
  if (quirk) {
    lines.push(`quirk: ${quirk}`);
    const rate = Math.min(100, Math.max(0, Math.round(Number(draft.quirkRate) || 0)));
    lines.push(`quirk_rate: ${rate / 100}`);
  }
  for (const key of PERSONA_REPLY_KEYS) {
    const reply = oneLine(draft.replies[key] ?? "");
    if (reply) lines.push(`reply.${key}: ${reply}`);
  }
  // The front matter is always written, even when empty: a body that begins with --- must never be read as one.
  return `---\n${lines.join("\n")}\n---\n${bodyText(draft.body)}\n`;
}

function draftFrom(text: string): CustomDraft {
  const { fields, body } = splitPersona(text);
  const rate = Number(fields.get("quirk_rate"));
  const replies: Record<string, string> = {};
  for (const key of PERSONA_REPLY_KEYS) {
    const value = oneLine(fields.get(`reply.${key}`) ?? "");
    if (value) replies[key] = cut(value, CUSTOM_LIMITS.reply);
  }
  return {
    name: cut(oneLine(fields.get("name") ?? "") || "gork", CUSTOM_LIMITS.name),
    body: cut(bodyText(body), CUSTOM_LIMITS.body),
    quirk: cut(oneLine(fields.get("quirk") ?? ""), CUSTOM_LIMITS.quirk),
    quirkRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? Math.round(rate * 100) : 0,
    replies,
  };
}

function readSmall(file: string): string | null {
  try {
    if (statSync(file).size > READ_LIMIT) return "";
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * What the editor starts with: the person's own personas/custom.md if there is one, else the example file with its
 * comment lines left out. `placeholders` are the `[bracketed]` parts of the example, which still need replacing.
 */
export function loadDraft(dir: string): { exists: boolean; draft: CustomDraft; placeholders: string[] } {
  const example = readSmall(join(dir, EXAMPLE_FILE));
  const placeholders = example === null ? [] : [...new Set(splitPersona(example).body.match(/\[[^\]\n]+\]/g) ?? [])];
  const own = readSmall(join(dir, CUSTOM_FILE));
  if (own !== null) return { exists: true, draft: draftFrom(own), placeholders };
  return { exists: false, draft: draftFrom(example ?? ""), placeholders };
}

/**
 * Puts `text` at `<dir>/custom.md`, whole or not at all: it is written and synced to a temporary file in the same folder,
 * then renamed over the old one. The path is fixed here; a link at custom.md is replaced, not written through.
 */
export function writeCustomFile(dir: string, text: string): void {
  const temp = join(dir, `.custom-${randomBytes(6).toString("hex")}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(temp, "wx");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, join(dir, CUSTOM_FILE));
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* it was never made, or is already gone */
    }
    const why = (err as NodeJS.ErrnoException).code ?? "an error";
    throw new CliError(
      `couldn't save personas/${CUSTOM_FILE} (${why}). Close any program that has it open, and try again.`,
    );
  }
}
