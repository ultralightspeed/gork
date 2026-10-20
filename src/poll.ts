import type { PollData } from "discord.js";
import { stripInvisible } from "./context.ts";

// Discord's own limits for a native poll.
export const MAX_QUESTION = 300;
export const MAX_ANSWER = 55;
export const MIN_ANSWERS = 2;
export const MAX_ANSWERS = 10;
export const MAX_HOURS = 768;
export const DEFAULT_HOURS = 24;

export type Poll = { question: string; answers: string[]; durationHours: number; multiselect: boolean };

const text = (v: unknown) => (typeof v === "string" ? stripInvisible(v).trim() : "");

/**
 * Validates model-supplied poll arguments, without invisible characters. Returns the poll, or a reason the model can
 * act on.
 */
export function parsePoll(args: Record<string, unknown>): Poll | string {
  const question = text(args.question);
  if (!question || question.length > MAX_QUESTION) return `question must be 1-${MAX_QUESTION} characters.`;
  const raw = args.answers;
  if (!Array.isArray(raw) || raw.length < MIN_ANSWERS || raw.length > MAX_ANSWERS)
    return `answers must be a list of ${MIN_ANSWERS}-${MAX_ANSWERS} options.`;
  const answers = raw.map(text);
  if (answers.some((a) => !a || a.length > MAX_ANSWER))
    return `each of the answers must be 1-${MAX_ANSWER} characters.`;
  if (new Set(answers.map((a) => a.toLowerCase())).size !== answers.length) return "answers must all be different.";
  const hours = args.duration_hours ?? DEFAULT_HOURS;
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS)
    return `duration_hours must be a whole number from 1 to ${MAX_HOURS}.`;
  return { question, answers, durationHours: hours, multiselect: args.allow_multiselect === true };
}

export function toDiscordPoll(p: Poll): PollData {
  return {
    question: { text: p.question },
    answers: p.answers.map((text) => ({ text })),
    duration: p.durationHours,
    allowMultiselect: p.multiselect,
  };
}
