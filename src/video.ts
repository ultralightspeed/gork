// Reads a Discord-hosted video: which ones to read, a pool of one frame per second, and a Whisper transcript.
import { cfFetch, isFreeAllowanceExhausted } from "./cf.ts";
import type { Config } from "./config.ts";
import { neutralize } from "./context.ts";
import { describeError } from "./errors.ts";
import {
  audioArgs,
  FfmpegError,
  frameArgs,
  type Gate,
  hasAudioStream,
  inputArgs,
  runFfmpeg,
  type SpawnFn,
  splitJpegs,
  windowInputArgs,
} from "./ffmpeg.ts";

const HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
/** The content types whose containers ffmpeg's demuxer whitelist covers (see DEMUXERS in ffmpeg.ts). */
const TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/3gpp"]);
const MAX_BYTES = 25 * 1024 * 1024;
/** About 1080p. ffmpeg decodes inside a 384 MB container next to Node, so 1440p and 4K are declined. */
const MAX_PIXELS = 2_200_000;

/** Longest video gork will watch, in seconds; longer ones are declined. It is also the most frames in the pool. */
export const VIDEO_MAX_SECONDS = 60;

const FRAMES_TIMEOUT_MS = 25_000;
const AUDIO_TIMEOUT_MS = 25_000;
const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const TRANSCRIPT_CHARS = 2000;
const MP3_BYTES_PER_SECOND = 4000; // 32 kbps

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** USD per audio minute, from the model page (the pricing page says $0.0005; this is the higher of the two). */
const WHISPER_USD_PER_MINUTE = 0.000513;
const whisperUsd = (seconds: number) => (seconds / 60) * WHISPER_USD_PER_MINUTE;

/** A video attachment as the adapter reads it from Discord; every metadata field may be missing. */
export type VideoSource = {
  url: string;
  contentType?: string | null;
  size?: number | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
};

export type VideoFrame = { dataUrl: string; atSec: number };

export const jpegDataUrl = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString("base64")}`;

/** What reading one video produced. Never an error: whatever could not be done is in `notes`, for the model. */
export type VideoResult = {
  /** The pool: every frame read, one per second, at most VIDEO_MAX_SECONDS of them. All are screened; few are shown. */
  frames: VideoFrame[];
  /** The URL the frames came from, as checked (what a later read of one window uses); "" when nothing was read. */
  url: string;
  /** Speech-to-text of the soundtrack, inert (no angle brackets) and clipped. "" when there was none. */
  transcript: string;
  notes: string[];
  costUsd: number;
  /** What was reserved in the budget; the caller settles it with `costUsd`. */
  reservedUsd: number;
};

const isDiscordHttps = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && HOSTS.has(u.hostname) && !u.username && !u.password && !u.port;
  } catch {
    return false;
  }
};

/**
 * The Discord-hosted video to watch, chosen by metadata alone so nothing is fetched for a clip that is too big.
 * Non-videos and other hosts are ignored without comment; a Discord video that is declined gets a note for the model.
 */
export function pickVideos(sources: VideoSource[], videosPerDay: number): { urls: string[]; skipped: string[] } {
  const none = { urls: [], skipped: [] };
  if (videosPerDay === 0) return none;
  const urls: string[] = [];
  const skipped: string[] = [];
  let extra = false;
  for (const s of sources) {
    const type = s.contentType?.split(";")[0].trim().toLowerCase();
    if (!type?.startsWith("video/") || !isDiscordHttps(s.url)) continue;
    const why = declineReason(s, type);
    if (why) skipped.push(why);
    else if (urls.length === 0) urls.push(s.url);
    else extra = true;
  }
  if (extra) skipped.push("Only the first video was watched; the others were not.");
  return { urls, skipped };
}

function declineReason(s: VideoSource, type: string): string | null {
  if (!TYPES.has(type)) return `A video (${type}) was attached, but that format isn't supported, so it wasn't watched.`;
  if (s.size != null && s.size > MAX_BYTES)
    return `A video was attached but it is too large (${Math.ceil(s.size / 1048576)} MB, the limit is ${MAX_BYTES / 1048576} MB), so it wasn't watched.`;
  if (s.durationSec != null && s.durationSec > VIDEO_MAX_SECONDS)
    return `A video was attached but it is too long (${Math.ceil(s.durationSec)} s, the limit is ${VIDEO_MAX_SECONDS} s), so it wasn't watched.`;
  if (s.width != null && s.height != null && s.width * s.height > MAX_PIXELS)
    return `A video was attached but its resolution (${s.width}x${s.height}) is too high, so it wasn't watched.`;
  return null;
}

export type VideoDeps = {
  fetch?: typeof fetch;
  spawnFn?: SpawnFn;
  /** Only one ffmpeg runs at a time, process-wide; reads queue behind it, and too long a queue is turned away. */
  gate: Gate;
  /** Asks the budget for room for the transcription (true if reserved). */
  reserve: (usd: number) => boolean;
  /** Today's allowance of videos: take() claims one. */
  slots: { take(): boolean };
  log?: (line: string) => void;
};

class OutOfSlots extends Error {}

const empty = (note: string): VideoResult => ({
  frames: [],
  url: "",
  transcript: "",
  notes: [note],
  costUsd: 0,
  reservedUsd: 0,
});

function explain(err: unknown): string {
  if (err instanceof FfmpegError) {
    if (err.kind === "busy") return "The video reader is busy with other videos right now, so this one wasn't watched.";
    if (err.kind === "missing") return "Watching videos isn't available on this setup, so the video wasn't watched.";
  }
  return "A video was attached, but it couldn't be read, so it wasn't watched.";
}

/** ffmpeg's stderr echoes the file's own metadata; keep control characters out of the log. */
const logSafe = (s: string) =>
  Array.from(s, (c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) ? " " : c;
  }).join("");

/**
 * Pulls frames (one per second) and the soundtrack out of a Discord-hosted video with ffmpeg, and transcribes the
 * sound. Never throws; the cost of the transcription is in the result.
 */
export async function readVideo(cfg: Config, urls: string[], deps: VideoDeps): Promise<VideoResult> {
  const log = deps.log ?? (() => {});
  const picked = urls.find(isDiscordHttps);
  if (!picked) return empty("A video was attached, but it couldn't be read, so it wasn't watched.");
  // ffmpeg gets the URL exactly as it was checked (the WHATWG serialization), not the raw string.
  const url = new URL(picked).href;

  const run = { timeoutMs: FRAMES_TIMEOUT_MS, maxStdout: MAX_FRAME_BYTES, spawnFn: deps.spawnFn };
  let jpegs: Buffer[];
  let mp3: Buffer | null = null;
  let audioFailed = false;
  try {
    ({ jpegs, mp3, audioFailed } = await deps.gate.run(async () => {
      // Claimed only once this read has its turn, so being turned away as busy costs no daily slot.
      if (!deps.slots.take()) throw new OutOfSlots();
      const frames = await runFfmpeg([...inputArgs(url, VIDEO_MAX_SECONDS), ...frameArgs()], run);
      const found = splitJpegs(frames.stdout);
      if (found.length === 0) throw new Error(`no frames (exit ${frames.code}): ${logSafe(frames.stderr.slice(-300))}`);
      if (!hasAudioStream(frames.stderr)) return { jpegs: found, mp3: null, audioFailed: false };
      try {
        const audio = await runFfmpeg([...inputArgs(url, VIDEO_MAX_SECONDS), ...audioArgs()], {
          ...run,
          timeoutMs: AUDIO_TIMEOUT_MS,
          maxStdout: MAX_AUDIO_BYTES,
        });
        return { jpegs: found, mp3: audio.stdout.length ? audio.stdout : null, audioFailed: audio.stdout.length === 0 };
      } catch (err) {
        log(`video: audio extraction failed: ${describeError(err)}`);
        return { jpegs: found, mp3: null, audioFailed: true };
      }
    }));
  } catch (err) {
    if (err instanceof OutOfSlots) return empty("The daily limit on videos is used up, so this one wasn't watched.");
    log(`video: ffmpeg failed: ${describeError(err)}`);
    return empty(explain(err));
  }

  // -t already stops the read at VIDEO_MAX_SECONDS; the slice is for a clip that rounds up to one frame more.
  const frames = jpegs.slice(0, VIDEO_MAX_SECONDS).map((jpeg, atSec) => ({ dataUrl: jpegDataUrl(jpeg), atSec }));
  const result: VideoResult = { frames, url, transcript: "", notes: [], costUsd: 0, reservedUsd: 0 };
  if (audioFailed) result.notes.push("The video's audio couldn't be read, so there is no transcript.");
  if (mp3) await transcribe(cfg, mp3, result, deps);
  return result;
}

/**
 * Reads one window of an already-picked video again, at `perSecond` frames per second, for video_frames. `url` is
 * the one readVideo checked, never something the model supplied, and it is checked again here. The same gate, input
 * limits, time limit and output cap as the first read; the window is the only difference. Throws on any failure
 * (FfmpegError for busy, missing, timeout and too-big); the caller turns that into text.
 */
export async function extractWindow(
  url: string,
  from: number,
  to: number,
  perSecond: number,
  deps: { gate: Gate; spawnFn?: SpawnFn },
): Promise<Buffer[]> {
  if (!isDiscordHttps(url)) throw new FfmpegError("failed", "not a Discord video URL");
  const args = [...windowInputArgs(new URL(url).href, from, to), ...frameArgs(perSecond)];
  const out = await deps.gate.run(() =>
    runFfmpeg(args, { timeoutMs: FRAMES_TIMEOUT_MS, maxStdout: MAX_FRAME_BYTES, spawnFn: deps.spawnFn }),
  );
  const found = splitJpegs(out.stdout);
  if (found.length === 0) throw new Error(`no frames (exit ${out.code}): ${logSafe(out.stderr.slice(-300))}`);
  return found;
}

/** Seconds as m:ss, the way a player shows them. */
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/** Whisper's spoken segments as one line each, "[0:07] words", so the model can tie words to moments. "" if there are none. */
function timestamped(segments: unknown): string {
  if (!Array.isArray(segments)) return "";
  const lines: string[] = [];
  for (const seg of segments) {
    const { start, text } = (seg ?? {}) as { start?: unknown; text?: unknown };
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0 || typeof text !== "string") continue;
    const words = text.trim();
    if (words) lines.push(`[${clock(start)}] ${words}`);
  }
  return lines.join("\n");
}

/** Whisper on the MP3; any failure leaves the frames in place and adds a note. */
async function transcribe(cfg: Config, mp3: Buffer, result: VideoResult, deps: VideoDeps): Promise<void> {
  const reserve = whisperUsd(VIDEO_MAX_SECONDS);
  if (!deps.reserve(reserve)) {
    result.notes.push("The daily budget is used up, so the video's audio wasn't transcribed.");
    return;
  }
  result.reservedUsd = reserve;
  try {
    const out = (await cfFetch(
      cfg,
      `/ai/run/${WHISPER_MODEL}`,
      { audio: mp3.toString("base64"), vad_filter: true },
      deps.fetch,
      30_000,
    )) as { text?: unknown; segments?: unknown };
    result.costUsd = whisperUsd(Math.min(VIDEO_MAX_SECONDS, mp3.length / MP3_BYTES_PER_SECOND));
    const text = timestamped(out.segments) || (typeof out.text === "string" ? out.text.trim() : "");
    if (text) result.transcript = neutralize(text, TRANSCRIPT_CHARS);
    else result.notes.push("No speech was heard in the video's audio.");
  } catch (err) {
    deps.log?.(`video: transcription failed: ${describeError(err)}`);
    result.notes.push(
      isFreeAllowanceExhausted(err)
        ? "Today's free transcription allowance is used up, so the video's audio wasn't transcribed."
        : "The video's audio couldn't be transcribed.",
    );
  }
}
