import { cfFetch, FreeAllowanceError, isFreeAllowanceExhausted } from "./cf.ts";
import type { Config } from "./config.ts";
import { sniffImageMime } from "./images.ts";

const MODEL = "@cf/black-forest-labs/flux-1-schnell";
const STEPS = 4;
const MAX_BYTES = 8 * 1024 * 1024;
/** The JSON answer: the image as base64 (4 bytes per 3) plus a little room. */
const MAX_ANSWER_BYTES = Math.ceil(MAX_BYTES / 3) * 4 + 64 * 1024;

export type GeneratedImage = { data: Buffer; mime: "image/png" | "image/jpeg"; costUsd: number };

/**
 * Generates an image (JPEG or PNG, whichever Workers AI returns) with FLUX.1 schnell, called directly on
 * Workers AI (not through the credit gateway) so it only ever uses the free daily allowance. Never retries on paid
 * credits.
 */
export async function generateImage(
  cfg: Config,
  prompt: string,
  fetchFn: typeof fetch = fetch,
): Promise<GeneratedImage> {
  let result: { image?: unknown } | undefined;
  try {
    const body = { prompt: prompt.slice(0, 2048), steps: STEPS };
    result = (await cfFetch(cfg, `/ai/run/${MODEL}`, body, fetchFn, 60_000, {
      maxBytes: MAX_ANSWER_BYTES,
    })) as typeof result;
  } catch (err) {
    if (isFreeAllowanceExhausted(err)) throw new FreeAllowanceError("free Workers AI allowance used up");
    throw err;
  }
  const b64 = result?.image;
  const data = typeof b64 === "string" ? Buffer.from(b64, "base64") : Buffer.alloc(0);
  const mime = sniffImageMime(data);
  if (!mime) throw new Error("FLUX returned something that is not an image");
  if (data.length > MAX_BYTES) throw new Error("generated image too large");
  return { data, mime, costUsd: 0 };
}
