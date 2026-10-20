import { describe, expect, it } from "vitest";
import { FfmpegError } from "../src/ffmpeg.ts";
import type { GuardVerdict } from "../src/guard.ts";
import type { VideoFrame } from "../src/video.ts";
import {
  VIDEO_FRAMES_PER_CALL,
  VIDEO_MAX_FRAMES_SHOWN,
  VIDEO_OVERVIEW_FRAMES,
  VideoWatch,
  videoOverview,
} from "../src/videolook.ts";

const url = (tag: string | number) => `data:image/jpeg;base64,${Buffer.from(`P${tag}`).toString("base64")}`;
const pool = (n: number): VideoFrame[] => Array.from({ length: n }, (_, i) => ({ dataUrl: url(i), atSec: i }));
const clean: GuardVerdict = { blocked: false, costUsd: 0.00004 };
const FRESH = VIDEO_MAX_FRAMES_SHOWN - VIDEO_OVERVIEW_FRAMES;

/** A VideoWatch over an n-second clip, with a fake ffmpeg and a fake guard that record what they were asked. */
function setup(
  o: {
    seconds?: number;
    extract?: (from: number, to: number, perSecond: number) => Promise<Buffer[]>;
    screen?: (frames: string[]) => Promise<GuardVerdict>;
  } = {},
) {
  const log: string[] = [];
  const extractCalls: [number, number, number][] = [];
  const screenCalls: string[][] = [];
  const watch = new VideoWatch(pool(o.seconds ?? 30), {
    extract: async (from, to, perSecond) => {
      log.push("extract");
      extractCalls.push([from, to, perSecond]);
      if (o.extract) return o.extract(from, to, perSecond);
      return Array.from({ length: (to - from) * perSecond }, (_, i) => Buffer.from(`N${from}-${i}`));
    },
    screen: async (frames) => {
      log.push("screen");
      screenCalls.push(frames);
      return o.screen ? o.screen(frames) : clean;
    },
  });
  return { watch, log, extractCalls, screenCalls };
}
const look = (w: VideoWatch, from: unknown, to: unknown, per?: unknown) =>
  w.look({ from_seconds: from, to_seconds: to, ...(per === undefined ? {} : { per_second: per }) });
const times = (r: { frames: VideoFrame[] }) => r.frames.map((f) => f.atSec);

describe("videoOverview", () => {
  it("picks a few frames spread over the pool, each with its second; a short clip is shown whole", () => {
    const o = videoOverview(pool(30));
    expect(o).toHaveLength(VIDEO_OVERVIEW_FRAMES);
    expect(o[0]).toEqual({ dataUrl: url(o[0].atSec), atSec: o[0].atSec });
    expect(times({ frames: o })).toEqual([...times({ frames: o })].sort((a, b) => a - b));
    expect(videoOverview(pool(5)).map((f) => f.atSec)).toEqual([0, 1, 2, 3, 4]);
    expect(videoOverview([])).toEqual([]);
  });

  it("shrinks the overview and every call to the room the asker's own images leave", async () => {
    const watch = new VideoWatch(pool(30), { extract: async () => [], screen: async () => clean }, 5);
    expect(watch.overview).toHaveLength(5);
    const r = await look(watch, 0, 30);
    expect(r.frames).toHaveLength(5);
  });
});

describe("video_frames at one frame per second: served from the screened pool", () => {
  it("returns the pool frames of the window, untouched, with no ffmpeg and no screening, labelled as untrusted", async () => {
    const t = setup();
    const r = await look(t.watch, 10, 13);
    expect(times(r)).toEqual([10, 11, 12]);
    expect(r.frames.map((f) => f.dataUrl)).toEqual([url(10), url(11), url(12)]);
    expect(r.costUsd).toBe(0);
    expect(t.log).toEqual([]);
    expect(r.text).toMatch(/10 s, 11 s, 12 s/);
    expect(r.text).toMatch(/untrusted/i);
    // The default rate (and an explicit 1) never re-read the window.
    await look(t.watch, 3, 6, 1);
    expect(t.extractCalls).toEqual([]);
  });

  it("thins a window of more than VIDEO_FRAMES_PER_CALL frames, and says how many it skipped over", async () => {
    const r = await look(setup({ seconds: 40 }).watch, 0, 40);
    expect(r.frames).toHaveLength(VIDEO_FRAMES_PER_CALL);
    expect(r.text).toMatch(/40 frames/);
  });

  it.each([
    ["rounds the window outward to whole seconds", 10.4, 12.2, 30, [10, 11, 12]],
    ["accepts numbers sent as strings, as models do", "3", "5", 30, [3, 4]],
    ["cuts a negative start to zero", -5, 2, 30, [0, 1]],
    ["cuts a window that runs past the end to the clip", 17, 99, 20, [17, 18, 19]],
  ])("%s", async (_what, from, to, seconds, expected) => {
    expect(times(await look(setup({ seconds }).watch, from, to))).toEqual(expected);
  });

  it.each([
    ["starts at the end of the clip", { from_seconds: 20, to_seconds: 30 }, /between 0 and 20/],
    ["ends where it starts", { from_seconds: 5, to_seconds: 5 }, /after from_seconds/],
    ["names no seconds", {}, /from_seconds/],
    ["gives the seconds as words", { from_seconds: "soon", to_seconds: 9 }, /from_seconds/],
    ["gives an infinite end", { from_seconds: 1, to_seconds: Number.POSITIVE_INFINITY }, /to_seconds/],
    ["asks for 0 frames a second", { from_seconds: 2, to_seconds: 4, per_second: 0 }, /per_second/],
    ["asks for more than 4 frames a second", { from_seconds: 2, to_seconds: 4, per_second: 5 }, /per_second/],
    ["asks for a fractional rate", { from_seconds: 2, to_seconds: 4, per_second: 1.5 }, /per_second/],
  ])("teaches the model the arguments, with no images and no work, when it %s", async (_what, args, hint) => {
    const t = setup({ seconds: 20 });
    const r = await t.watch.look(args);
    expect(r.frames).toEqual([]);
    expect(r.text).toMatch(hint);
    expect(t.log).toEqual([]);
    expect(t.watch.framesLeft).toBe(FRESH);
  });
});

describe("video_frames above one frame per second: only the window is read again, and screened first", () => {
  it("re-extracts just the window at the asked rate, labels frames by their moment, then screens exactly those", async () => {
    const t = setup();
    const r = await look(t.watch, 12, 14, 2);
    expect(t.extractCalls).toEqual([[12, 14, 2]]);
    expect(times(r)).toEqual([12, 12.5, 13, 13.5]);
    expect(t.screenCalls).toEqual([r.frames.map((f) => f.dataUrl)]);
    expect(t.log).toEqual(["extract", "screen"]);
    expect(r.costUsd).toBe(clean.costUsd);
  });

  it("screens only the frames it will show, when the window had more than a call can carry", async () => {
    const t = setup();
    const r = await look(t.watch, 4, 11, 4); // 7 s: 28 frames read
    expect(r.frames).toHaveLength(VIDEO_FRAMES_PER_CALL);
    expect(t.screenCalls[0]).toEqual(r.frames.map((f) => f.dataUrl));
  });

  it("answers a window of 8 s or more from the screened pool: faster sampling could not show more of it", async () => {
    const t = setup();
    const r = await look(t.watch, 0, 20, 4);
    expect(t.log).toEqual([]);
    expect(r.frames).toHaveLength(VIDEO_FRAMES_PER_CALL);
    const poolUrls = new Set(pool(30).map((f) => f.dataUrl));
    expect(r.frames.every((f) => poolUrls.has(f.dataUrl))).toBe(true);
  });

  it("returns no images when the screen blocks them, and does not say what it found", async () => {
    const t = setup({
      screen: async () => ({ blocked: true, category: "S4", p: 0.9, selfHarm: false, costUsd: 0.0001 }),
    });
    const r = await look(t.watch, 12, 14, 2);
    expect(r.frames).toEqual([]);
    expect(r.costUsd).toBe(0.0001);
    expect(r.text).not.toMatch(/S4|0\.9/);
    expect(t.watch.framesLeft).toBe(FRESH);
  });

  it("fails closed when the screen is down: no images, and no frames counted", async () => {
    const t = setup({
      screen: async () => {
        throw new Error("guard down");
      },
    });
    const r = await look(t.watch, 12, 14, 2);
    expect(r.frames).toEqual([]);
    expect(t.watch.framesLeft).toBe(FRESH);
  });

  it.each([
    ["busy", new FfmpegError("busy", "ffmpeg is busy")],
    ["failing", new Error("moov atom not found")],
  ])("gives no images, screens nothing and leaks no raw error when the video reader is %s", async (_how, err) => {
    const t = setup({
      extract: async () => {
        throw err;
      },
    });
    const r = await look(t.watch, 12, 14, 2);
    expect(r.frames).toEqual([]);
    expect(r.text).not.toContain(err.message);
    expect(t.screenCalls).toEqual([]);
    expect(t.watch.framesLeft).toBe(FRESH);
  });
});

describe("video_frames budget: the overview and every call share VIDEO_MAX_FRAMES_SHOWN", () => {
  it("stops at the total, counting the overview, and then serves nothing", async () => {
    const t = setup({ seconds: 60 });
    let shown = t.watch.overview.length;
    for (let i = 0; i < 6; i++) {
      const r = await look(t.watch, 0, 60);
      shown += r.frames.length;
      expect(r.frames).toHaveLength(VIDEO_FRAMES_PER_CALL);
    }
    expect(shown).toBe(VIDEO_OVERVIEW_FRAMES + 6 * VIDEO_FRAMES_PER_CALL);
    const last = await look(t.watch, 0, 60);
    expect(last.frames).toHaveLength(VIDEO_MAX_FRAMES_SHOWN - shown);
    expect(t.watch.framesLeft).toBe(0);
    const after = await look(t.watch, 0, 60);
    expect(after.frames).toEqual([]);
    expect(t.log).toEqual([]);
  });

  it("charges only for the frames it actually returned, pool or re-read, and tells the model how many are left", async () => {
    const t = setup({ seconds: 60 });
    const pooled = await look(t.watch, 5, 8);
    expect(t.watch.framesLeft).toBe(FRESH - 3);
    expect(pooled.text).toContain(`${t.watch.framesLeft} more`);
    const reread = await look(t.watch, 10, 12, 2);
    expect(t.watch.framesLeft).toBe(FRESH - 3 - reread.frames.length);
  });
});
