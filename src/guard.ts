import { cfFetch, FreeAllowanceError, isFreeAllowanceExhausted } from "./cf.ts";
import type { Config } from "./config.ts";

/** Only Clef speaks the questions/noul protocol below, so the model is not a setting. */
const GUARD_MODEL = "@cf/cloudflare/clef-flash";
const GUARD_PRICE_IN_PER_M = 0.038;
/** Most images Clef takes in one call. */
const MAX_IMAGES = 4;

const GAME =
  'Video games, fiction, sports, hyperbole and obvious jokes ("how do I beat the final boss", "I\'ll destroy you this match") do NOT count.';

const QUESTIONS: Record<string, { prompt: string; reply: string }> = {
  S1: {
    prompt: `Is the user seeking real-world help to plan or commit a violent crime against people or animals (murder, assault, kidnapping, terrorism)? Asking about news or history of violence does not count. ${GAME}`,
    reply: `Does this reply give real-world help to plan or commit a violent crime against people or animals? ${GAME}`,
  },
  S3: {
    prompt:
      "Is the user seeking help with a sex crime (sexual assault, sex trafficking, non-consensual sexual content)?",
    reply: "Does this reply help with a sex crime (sexual assault, sex trafficking, non-consensual sexual content)?",
  },
  S4: {
    prompt:
      "Does this text or any attached image involve sexual content involving minors, or sexualize anyone under 18?",
    reply: "Does this reply contain or describe sexual content involving minors?",
  },
  S9: {
    prompt: `Is the user seeking instructions for chemical, biological, radiological or nuclear weapons, or explosives meant to cause mass harm? ${GAME}`,
    reply:
      "Does this reply give instructions for chemical, biological, radiological or nuclear weapons, or explosives capable of mass harm?",
  },
  S11: {
    prompt: `Does the user express intent to harm or kill themselves, or ask for methods of suicide or self-harm? ${GAME}`,
    reply: "Does this reply encourage suicide or self-harm, or describe methods for it?",
  },
};

/** The categories the guard has questions for (the valid values of GUARD_BLOCK). */
export const GUARD_CATEGORIES = Object.keys(QUESTIONS);
const SELF_HARM = "S11";

export type GuardVerdict = ({ blocked: false } | { blocked: true; category: string; p: number; selfHarm: boolean }) & {
  costUsd: number;
};

function yesProbability(a: unknown): number {
  // Clef answers each question as { type: "noul", noul: <probability of yes> }. Anything else fails closed.
  if (a && typeof a === "object" && typeof (a as { noul?: unknown }).noul === "number") {
    return (a as { noul: number }).noul;
  }
  throw new Error(`unexpected guard answer shape: ${JSON.stringify(a)?.slice(0, 80)}`);
}

// The decision model reads at most this much text per call; longer text is screened in overlapping chunks.
const MAX_STATE = 6000;
const OVERLAP = 200;

/** Splits text into chunks of at most `size` characters that overlap, so nothing straddling a boundary is missed. */
function chunks(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - OVERLAP) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

/** Combines per-chunk verdicts: blocked if any chunk blocked (worst one wins); cost is the sum. */
function merge(verdicts: GuardVerdict[]): GuardVerdict {
  const costUsd = verdicts.reduce((sum, v) => sum + v.costUsd, 0);
  const worst = verdicts.filter((v) => v.blocked).sort((a, b) => (b.blocked && a.blocked ? b.p - a.p : 0))[0];
  return worst ? { ...worst, costUsd } : { blocked: false, costUsd };
}

/** `fetchFn` is for tests; `images` are data URLs screened along with the text. */
type Options = { fetchFn?: typeof fetch; images?: string[] };

/** Screens text with the decision model, all of it. Throws on any failure; callers must fail closed. */
export async function checkContent(
  cfg: Config,
  kind: "prompt" | "reply",
  state: string,
  { fetchFn = fetch, images = [] }: Options = {},
): Promise<GuardVerdict> {
  const parts = chunks(state, MAX_STATE);
  // Clef takes MAX_IMAGES per call. Text chunk i travels with image group i; whichever list is shorter is padded
  // by repeating the first text chunk (an image group still needs some text) or sending no images.
  const groups = Array.from({ length: Math.ceil(images.length / MAX_IMAGES) }, (_, i) =>
    images.slice(i * MAX_IMAGES, (i + 1) * MAX_IMAGES),
  );
  const calls = Math.max(parts.length, groups.length);
  return merge(
    await Promise.all(
      Array.from({ length: calls }, (_, i) => checkOnce(cfg, kind, parts[i] ?? parts[0], fetchFn, groups[i] ?? [])),
    ),
  );
}

/**
 * Screens a reply (plus any poll text) in full. Each chunk carries the start of the question so the model can
 * judge the reply in context, however long either is.
 */
export async function screenReply(
  cfg: Config,
  question: string,
  reply: string,
  { fetchFn = fetch }: Pick<Options, "fetchFn"> = {},
): Promise<GuardVerdict> {
  const context = `User asked: ${question.slice(0, 1000)}

Reply: `;
  const parts = chunks(reply, MAX_STATE - context.length);
  return merge(await Promise.all(parts.map((part) => checkOnce(cfg, "reply", context + part, fetchFn, []))));
}

/** Screens generated images the way a reply is screened; `context` is the text that describes them. */
export function screenImages(
  cfg: Config,
  images: string[],
  context: string,
  opts: Pick<Options, "fetchFn"> = {},
): Promise<GuardVerdict> {
  return checkContent(cfg, "reply", context, { ...opts, images });
}

/**
 * Screens images that aren't the asker's own words, as untrusted content in their request (the prompt questions). It
 * only tells whether they pass, so there is no strike. Throws on any failure.
 */
async function screenUntrustedImages(
  cfg: Config,
  what: string,
  images: string[],
  fetchFn: typeof fetch | undefined,
): Promise<GuardVerdict> {
  if (images.length === 0) return { blocked: false, costUsd: 0 };
  return checkContent(cfg, "prompt", what, { fetchFn, images });
}

/** Screens frames taken from a video (see screenUntrustedImages). */
export function screenFrames(
  cfg: Config,
  frames: string[],
  { fetchFn }: Pick<Options, "fetchFn"> = {},
): Promise<GuardVerdict> {
  return screenUntrustedImages(cfg, "Frames taken from a video attached to the message.", frames, fetchFn);
}

/**
 * Screens an image posted earlier in the chat that the model asked to see (view_images; see screenUntrustedImages),
 * together with `question`, the asker's words: an image is judged by what it is asked about, as a replied-to image is.
 */
export function screenEarlierImages(
  cfg: Config,
  question: string,
  images: string[],
  { fetchFn }: Pick<Options, "fetchFn"> = {},
): Promise<GuardVerdict> {
  return screenUntrustedImages(
    cfg,
    `Message: ${question}

An image posted earlier in the chat, which the message may be about.`,
    images,
    fetchFn,
  );
}

async function checkOnce(
  cfg: Config,
  kind: "prompt" | "reply",
  clipped: string,
  fetchFn: typeof fetch,
  images: string[],
): Promise<GuardVerdict> {
  const ids = [...cfg.guard.block].filter((id) => id in QUESTIONS);
  if (ids.length === 0) return { blocked: false, costUsd: 0 };
  const questions = Object.fromEntries(ids.map((id) => [id, { type: "noul", instructions: QUESTIONS[id][kind] }]));
  const costUsd = ((Math.ceil(clipped.length / 3.5) + 300 + images.length * 1024) * GUARD_PRICE_IN_PER_M) / 1e6;
  let result: { answers?: Record<string, unknown> };
  try {
    const body: Record<string, unknown> = { model: GUARD_MODEL.split("/").pop(), state: clipped, questions };
    if (images.length) body.images = images;
    result = (await cfFetch(cfg, `/ai/run/${GUARD_MODEL}`, body, fetchFn, 20_000)) as typeof result;
  } catch (err) {
    if (isFreeAllowanceExhausted(err)) throw new FreeAllowanceError("Workers AI free allowance exhausted");
    throw err;
  }
  if (!result.answers) throw new Error("guard returned no answers");
  let worst: { category: string; p: number } | null = null;
  for (const id of ids) {
    const p = yesProbability(result.answers[id]);
    if (p >= cfg.guard.threshold && (!worst || p > worst.p)) worst = { category: id, p };
  }
  return worst
    ? { blocked: true, ...worst, selfHarm: worst.category === SELF_HARM, costUsd }
    : { blocked: false, costUsd };
}

export type ScreenVerdict = GuardVerdict & { strike: boolean };

/**
 * Screens a request: the asker's words plus what they replied to (and images). `videoText` is what was heard in an
 * attached video, already clipped ("" for a video with no speech, null for no video). If it blocks only because of the replied-to message or the video, it still
 * blocks but the asker gets no strike.
 */
export async function screenRequest(
  cfg: Config,
  question: string,
  replyTo: string | null,
  {
    fetchFn,
    images = [],
    replyImages = [],
    videoText = null,
    frames = [],
  }: Options & { replyImages?: string[]; videoText?: string | null; frames?: string[] } = {},
): Promise<ScreenVerdict> {
  const combined = await checkContent(
    cfg,
    "prompt",
    `Message: ${question}

Replying to: ${replyTo ?? "(nothing)"}${
      videoText
        ? `

Video audio transcript: ${videoText}`
        : ""
    }`,
    { fetchFn, images: [...images, ...replyImages, ...frames] },
  );
  if (!combined.blocked) return { blocked: false, strike: false, costUsd: combined.costUsd };
  if (replyTo === null && replyImages.length === 0 && videoText === null && frames.length === 0)
    return { ...combined, strike: true };
  // Re-check only what the asker sent: their words and their own images.
  const own = await checkContent(cfg, "prompt", `Message: ${question}`, {
    fetchFn,
    images,
  });
  return { ...combined, strike: own.blocked, costUsd: combined.costUsd + own.costUsd };
}
