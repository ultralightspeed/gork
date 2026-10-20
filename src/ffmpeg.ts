// Runs ffmpeg on hostile media: argument builders, a hard-limited process runner and a one-at-a-time gate.
// No policy here (which videos, how many frames); that is video.ts.
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

/** Containers Discord videos come in. Everything else (playlists, concat scripts, raw streams) is never parsed. */
const DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm";
/** What a signed https fetch needs. No file, hls, concat, subfile, http, udp, crypto or pipe on the input side. */
const PROTOCOLS = "https,tls,tcp";
/** Largest single allocation. 1080p decodes well under it; a tiny file claiming a 16k frame is refused. */
const MAX_ALLOC = 16 * 1024 * 1024;
/**
 * Certificates ffmpeg verifies Discord's CDN against. The Docker image ships this bundle; anywhere else
 * (running on the host for development), point SSL_CERT_FILE at one, as OpenSSL tools do.
 */
export const caBundle = (env: Record<string, string | undefined> = process.env) =>
  env.SSL_CERT_FILE || "/etc/ssl/certs/ca-certificates.crt";

/** Everything that must come before `-i` except how far to read: how to read the input, safely. */
function guardedInput(caFile: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-threads",
    "1",
    "-protocol_whitelist",
    PROTOCOLS,
    "-format_whitelist",
    DEMUXERS,
    "-max_redirects",
    "0",
    "-max_alloc",
    String(MAX_ALLOC),
    "-tls_verify",
    "1",
    "-ca_file",
    caFile,
  ];
}

/** Options that must come before `-i`: how to read the input, and how far into it. */
export function inputArgs(url: string, maxSeconds: number, caFile = caBundle()): string[] {
  return [...guardedInput(caFile), "-t", String(maxSeconds), "-i", url];
}

/**
 * Like inputArgs, but reads only the window from `from` to `to` seconds (whole seconds, `to` after `from`): -ss and
 * -to, both before -i so ffmpeg seeks instead of decoding from the start. There is no -t here, because ffmpeg lets
 * -t win over -to. The window is the only thing that differs from inputArgs; every limit is the same.
 */
export function windowInputArgs(url: string, from: number, to: number, caFile = caBundle()): string[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from)
    throw new RangeError(`bad video window ${from}-${to}: need whole seconds with 0 <= from < to`);
  return [...guardedInput(caFile), "-ss", String(from), "-to", String(to), "-i", url];
}

/** Most frames per second a window may be read at; the video_frames tool offers 1 to this. */
export const MAX_FRAMES_PER_SECOND = 4;

/** `perSecond` JPEGs per second of video (one by default), at most 640px wide, as an MJPEG stream on stdout; stream info goes to stderr. */
export function frameArgs(perSecond = 1): string[] {
  if (!Number.isInteger(perSecond) || perSecond < 1 || perSecond > MAX_FRAMES_PER_SECOND)
    throw new RangeError(`frames per second must be a whole number from 1 to ${MAX_FRAMES_PER_SECOND}`);
  return [
    "-v",
    "info",
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-threads",
    "1",
    "-vf",
    `fps=${perSecond},scale='min(640,iw)':-2`,
    "-q:v",
    "7",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "pipe:1",
  ];
}

/** The first audio track as mono 16 kHz 32 kbps MP3 on stdout (about 240 KB a minute). */
export function audioArgs(): string[] {
  return [
    "-v",
    "error",
    "-map",
    "0:a:0",
    "-vn",
    "-sn",
    "-dn",
    "-threads",
    "1",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    "-f",
    "mp3",
    "pipe:1",
  ];
}

/** Whether ffmpeg's `-v info` stream listing shows an audio track on the input. */
export const hasAudioStream = (stderr: string) => /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr);

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * Splits an MJPEG stream into its JPEGs. Entropy-coded JPEG data never contains FF D9 (FF is stuffed as FF 00),
 * so the first EOI after an SOI ends the frame. Bytes outside SOI..EOI (junk, a cut-off last frame) are dropped.
 */
export function splitJpegs(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const start = buf.indexOf(SOI, at);
    if (start === -1) return out;
    const end = buf.indexOf(EOI, start + 2);
    if (end === -1) return out;
    out.push(buf.subarray(start, end + 2));
    at = end + 2;
  }
}

/** `n` items spread across the list, each from the middle of its share; all of them when there are n or fewer. */
export function pickEvenly<T>(items: T[], n: number): { item: T; index: number }[] {
  if (items.length <= n) return items.map((item, index) => ({ item, index }));
  return Array.from({ length: n }, (_, i) => {
    const index = Math.floor(((i + 0.5) * items.length) / n);
    return { item: items[index], index };
  });
}

type FfmpegErrorKind = "missing" | "timeout" | "too-big" | "busy" | "failed";

export class FfmpegError extends Error {
  kind: FfmpegErrorKind;
  constructor(kind: FfmpegErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** The part of a child process runFfmpeg uses; node's ChildProcess satisfies it. */
export type ChildLike = {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "close", cb: (code: number | null) => void): unknown;
  once(event: "error", cb: (err: Error) => void): unknown;
};
export type SpawnFn = (cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => ChildLike;

const nodeSpawn: SpawnFn = (cmd, args, opts) =>
  spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: opts.env, windowsHide: true });

/** ffmpeg gets PATH to be found and nothing else, so a parser exploit can't read the bot's tokens. */
function bareEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { PATH: process.env.PATH ?? "" };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

const STDERR_KEEP = 64 * 1024;

/**
 * Runs ffmpeg and collects its output. Kills it at `timeoutMs` and when stdout passes `maxStdout`; rejects with an
 * FfmpegError then. A non-zero exit is returned, not thrown: ffmpeg often exits non-zero after a good first part.
 */
export function runFfmpeg(
  args: string[],
  o: { timeoutMs: number; maxStdout: number; spawnFn?: SpawnFn; bin?: string; killGraceMs?: number },
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = (o.spawnFn ?? nodeSpawn)(o.bin ?? "ffmpeg", args, { env: bareEnv() });
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    let failure: FfmpegError | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      fn();
    };
    // Kill, but report the failure only once the process has exited, so the gate never lets two run at once.
    const abort = (e: FfmpegError) => {
      if (settled || failure) return;
      failure = e;
      clearTimeout(timer);
      child.kill("SIGKILL");
      grace = setTimeout(() => finish(() => reject(e)), o.killGraceMs ?? 5000);
    };
    const timer = setTimeout(() => abort(new FfmpegError("timeout", `ffmpeg ran past ${o.timeoutMs} ms`)), o.timeoutMs);
    // Both pipes are drained from the start, or a full pipe would stall ffmpeg.
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || failure) return;
      outBytes += chunk.length;
      if (outBytes > o.maxStdout) {
        abort(new FfmpegError("too-big", `ffmpeg output passed ${o.maxStdout} bytes`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (err.length < STDERR_KEEP) err = (err + chunk.toString("latin1")).slice(0, STDERR_KEEP);
    });
    child.once("error", (e: Error) => {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      finish(() => reject(new FfmpegError(missing ? "missing" : "failed", `ffmpeg: ${e.message}`)));
    });
    child.once("close", (code: number | null) =>
      finish(() => (failure ? reject(failure) : resolve({ stdout: Buffer.concat(out), stderr: err, code }))),
    );
  });
}

/** Lets one job run at a time and turns away work when more than `maxWaiting` jobs are already queued. */
export class Gate {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private maxWaiting: number;

  constructor(maxWaiting: number) {
    this.maxWaiting = maxWaiting;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    if (this.pending > this.maxWaiting) return Promise.reject(new FfmpegError("busy", "ffmpeg is busy"));
    this.pending++;
    const result = this.tail.then(job);
    this.tail = result.catch(() => {});
    return result.finally(() => {
      this.pending--;
    });
  }
}
