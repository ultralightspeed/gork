import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.ts";
import type { Msg } from "../src/context.ts";
import { Gate, windowInputArgs } from "../src/ffmpeg.ts";
import { screenFrames, screenImages, screenReply, screenRequest } from "../src/guard.ts";
import { Limits } from "../src/limits.ts";
import { answer } from "../src/llm.ts";
import { type Replies, type RespondDeps, type RespondRequest, respond } from "../src/respond.ts";
import { newToolState, runTool } from "../src/tools.ts";
import { extractWindow, type VideoResult } from "../src/video.ts";
import { VideoWatch } from "../src/videolook.ts";
import { exit, fakeSpawn } from "./fake-ffmpeg.ts";
import { type Call, fakeFetch, json, testConfig } from "./helpers.ts";

// A whole reply about a video through the real model loop, the real video_frames tool, the real guard calls and the
// real ffmpeg arguments, with only the network and the ffmpeg process faked.

const CLIP = "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=a&is=b&hm=c";
const POOL = 20;
const NEW_FRAME = Buffer.from([0xff, 0xd8, 0x99, 0xff, 0xd9]); // what the fake ffmpeg returns for a window
const NEW_FRAME_URL = `data:image/jpeg;base64,${NEW_FRAME.toString("base64")}`;

const replies: Replies = {
  blocked: "BLOCKED",
  selfHarm: "SELF_HARM",
  outOfBudget: "OUT_OF_BUDGET",
  busy: "BUSY",
  error: "ERROR",
  guardDown: "GUARD_DOWN",
  allowanceOut: "ALLOWANCE_OUT",
  imageBlocked: "IMAGE_BLOCKED",
  imageUnchecked: "IMAGE_UNCHECKED",
  empty: "EMPTY",
  emptyAnswer: "EMPTY_ANSWER",
  cooldown: () => "COOLDOWN",
  noAttach: "(NO_ATTACH)",
  noPoll: "(NO_POLL)",
  noEvent: "(NO_EVENT)",
  eventFailed: "(EVENT_FAILED)",
  eventChangeFailed: "(EVENT_CHANGE_FAILED)",
  eventDeleteFailed: "(EVENT_DELETE_FAILED)",
};
const msg = (content: string): Msg => ({
  authorName: "amy",
  isSelf: false,
  content,
  attachments: [],
  embeds: [],
  images: [],
});
const completion = (message: object) =>
  json({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
const lookCall = (args: object) => ({
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "video_frames", arguments: JSON.stringify(args) } }],
});

async function reply(o: { flagNewFrames?: boolean; maxToolCalls?: string; askerImages?: number } = {}) {
  const own = Array.from({ length: o.askerImages ?? 0 }, (_, i) => `data:image/png;base64,A${i}`);
  const cfg = testConfig(o.maxToolCalls ? { MAX_TOOL_CALLS: o.maxToolCalls } : {});
  const chat = [
    () => completion(lookCall({ from_seconds: 4, to_seconds: 6, per_second: 2 })),
    () => completion({ content: "At 4.5 s the man waves." }),
  ];
  const cf = fakeFetch((c: Call) => {
    if (c.url.endsWith("/chat/completions")) return (chat.shift() ?? (() => completion({ content: "done" })))();
    if (c.url.includes("clef-flash")) {
      const flagged = o.flagNewFrames && (c.body.images ?? []).includes(NEW_FRAME_URL);
      const answers = Object.fromEntries(
        ["S1", "S3", "S4", "S9", "S11"].map((k) => [k, { type: "noul", noul: flagged && k === "S4" ? 0.95 : 0 }]),
      );
      return json({ success: true, result: { answers } });
    }
    return json({ error: "unexpected" }, 500);
  });
  const ff = fakeSpawn((child) => {
    child.stdout.write(Buffer.concat([NEW_FRAME, NEW_FRAME, NEW_FRAME, NEW_FRAME]));
    exit(child, 0);
  });
  const gate = new Gate(2);
  const state = newToolState(cfg);
  const pool = Array.from({ length: POOL }, (_, i) => ({ dataUrl: `data:image/jpeg;base64,P${i}`, atSec: i }));
  const video: VideoResult = {
    frames: pool,
    url: new URL(CLIP).href,
    transcript: "[0:03] hello",
    notes: [],
    costUsd: 0,
    reservedUsd: 0,
  };
  const deps: RespondDeps = {
    cfg,
    limits: new Limits(0, 3),
    budget: new Budget(join(mkdtempSync(join(tmpdir(), "gork-")), "ledger.json"), 1),
    replies,
    botName: "gork",
    log: () => {},
    systemPrompt: () => "SYSTEM",
    downloadImages: async () => own,
    readVideo: async () => video,
    videoWatch: (v, room) =>
      new VideoWatch(
        v.frames,
        {
          extract: (from, to, per) => extractWindow(v.url, from, to, per, { gate, spawnFn: ff.spawnFn }),
          screen: (frames) => screenFrames(cfg, frames, { fetchFn: cf.f }),
        },
        room,
      ),
    viewEarlierImages: () => {
      throw new Error("this chat has no history, so no earlier images");
    },
    screenRequest: (q, r, media) => screenRequest(cfg, q, r, { ...media, fetchFn: cf.f }),
    screenReply: (q, text) => screenReply(cfg, q, text, { fetchFn: cf.f }),
    screenImages: (images, context) => screenImages(cfg, images, context, { fetchFn: cf.f }),
    answer: (messages, { video: watch }) =>
      answer(cfg, messages, {
        fetch: cf.f,
        reserve: (usd) => deps.budget.tryReserve(usd),
        offer: { video: !!watch },
        runTool: (name, args, tally, turn) =>
          runTool(cfg, name, args, {
            state,
            tally,
            fetch: cf.f,
            video: watch ?? undefined,
            reserve: turn.reserve,
            deadline: turn.deadline,
          }),
      }),
  };
  const req: RespondRequest = {
    userId: "u1",
    who: "amy(u1)",
    where: "Test Server",
    channelId: "c1",
    question: msg("when does the man wave?"),
    replyTo: null,
    imageUrls: own.map((_, i) => `https://cdn.discordapp.com/attachments/1/2/a${i}.png`),
    video: { urls: [CLIP], skipped: [] },
    can: { send: true, attach: true, poll: true },
    mayPingEveryone: false,
    mayCreateEvents: false,
    mayCreatePolls: false,
    events: null,
    history: async () => [],
  };
  const outcome = await respond(req, deps);
  const modelCalls = cf.calls.filter((c) => c.url.endsWith("/chat/completions"));
  const guardCalls = cf.calls.filter((c) => c.url.includes("clef-flash"));
  return { outcome, modelCalls, guardCalls, all: cf.calls, ff, deps };
}

type Part = { type: string; text?: string; image_url?: { url: string } };

const imageCount = (c: Call) =>
  (c.body.messages as { content: unknown }[])
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Part[]) : []))
    .filter((p) => p.type === "image_url").length;

describe("a reply about a video, end to end", () => {
  it("never sends the model more than 8 images in one request (Workers AI rejects a 9th), keeping the asker's own", async () => {
    const { outcome, modelCalls } = await reply({ askerImages: 3 });
    expect(outcome?.text).toBe("At 4.5 s the man waves.");
    expect(modelCalls.map(imageCount)).toEqual([8, 8]);
    // The overview shrinks to fit beside the asker's 3 images, and their images stay in every request.
    for (const c of modelCalls) expect(JSON.stringify(c.body.messages)).toContain("A2");
    expect(JSON.stringify(modelCalls[0].body.messages[1].content).match(/Frame at/g)).toHaveLength(5);
    // The overview frames drop out once the new ones arrive; their labels say so.
    expect(JSON.stringify(modelCalls[1].body.messages[1].content)).toContain("no longer attached");
  });

  it("shows the overview, lets the model ask for a window at a higher rate, and answers from the new frames", async () => {
    const { outcome, modelCalls, ff } = await reply();
    expect(outcome?.text).toBe("At 4.5 s the man waves.");
    expect(modelCalls).toHaveLength(2);
    // 8 overview frames plus 4 new ones would be 12: the oldest drop out, so no request passes 8.
    for (const c of modelCalls) expect(imageCount(c)).toBeLessThanOrEqual(8);

    // First call: the overview (8 of the 20 screened frames) with the tool on offer.
    const first = modelCalls[0].body;
    const overview = (first.messages[1].content as Part[]).filter((p) => p.type === "image_url");
    expect(overview).toHaveLength(8);
    expect(first.tools.map((t: any) => t.function.name)).toContain("video_frames");

    // Only the window was read again, with the hardened args plus -ss/-to.
    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0].args.slice(0, windowInputArgs(CLIP, 4, 6).length)).toEqual(
      windowInputArgs(new URL(CLIP).href, 4, 6),
    );
    expect(ff.calls[0].args.join(" ")).toContain("fps=2,");

    // Second call: assistant, tool result, then one user message holding the new frames, each after its time.
    const tail = modelCalls[1].body.messages.slice(2);
    expect(tail.map((m: any) => m.role)).toEqual(["assistant", "tool", "user"]);
    const follow = tail[2].content as Part[];
    expect(follow.filter((p) => p.type === "image_url").map((p) => p.image_url?.url)).toEqual(
      Array(4).fill(NEW_FRAME_URL),
    );
    expect(follow.filter((p) => p.text?.startsWith("Frame at")).map((p) => p.text)).toEqual([
      "Frame at 4 s",
      "Frame at 4.5 s",
      "Frame at 5 s",
      "Frame at 5.5 s",
    ]);
  });

  it("screened the whole pool before the model, and the new frames before they were returned", async () => {
    const { all } = await reply();
    const at = (pred: (c: Call) => boolean) => all.map(pred).flatMap((x, i) => (x ? [i] : []));
    const guard = at((c) => c.url.includes("clef-flash"));
    const model = at((c) => c.url.endsWith("/chat/completions"));
    const withImages = (n: number) => at((c) => (c.body?.images ?? []).length === n);
    // 20 pool frames, four to a call: five screens, all before the first model call.
    const poolScreens = guard.filter((i) => i < model[0]);
    expect(poolScreens).toHaveLength(5);
    expect(poolScreens.every((i) => withImages(4).includes(i))).toBe(true);
    // The window's four new frames: one screen, after the first model call and before the second.
    const newScreens = guard.filter((i) => i > model[0] && i < model[1]);
    expect(newScreens).toHaveLength(1);
    expect(all[newScreens[0]].body.images).toEqual(Array(4).fill(NEW_FRAME_URL));
    // After the second model call only the reply is screened (no images).
    expect(guard.filter((i) => i > model[1]).map((i) => all[i].body.images)).toEqual([undefined]);
  });

  it("returns no images, and still answers, when the new frames are flagged", async () => {
    const { outcome, modelCalls } = await reply({ flagNewFrames: true });
    expect(outcome?.text).toBe("At 4.5 s the man waves.");
    const tail = modelCalls[1].body.messages.slice(2);
    expect(tail.map((m: any) => m.role)).toEqual(["assistant", "tool"]);
    expect(tail[1].content).toMatch(/can't be shown/);
    expect(JSON.stringify(modelCalls[1].body.messages)).not.toContain(NEW_FRAME_URL);
  });

  it("offers no tool and reads nothing again when tool calls are switched off", async () => {
    const { modelCalls, ff } = await reply({ maxToolCalls: "0" });
    expect(modelCalls[0].body.tools).toBeUndefined();
    expect(ff.calls).toHaveLength(0);
    const text = (modelCalls[0].body.messages[1].content as Part[])[0].text;
    expect(text).not.toContain("video_frames");
  });
});
