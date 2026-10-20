import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Budget } from "../src/budget.ts";
import { FreeAllowanceError } from "../src/cf.ts";
import type { ChatMessage, Msg } from "../src/context.ts";
import type { ScheduledEvent } from "../src/event.ts";
import type { GuardVerdict, ScreenVerdict } from "../src/guard.ts";
import { GUARD_CATEGORIES, screenRequest } from "../src/guard.ts";
import { Limits } from "../src/limits.ts";
import type { LinkSet } from "../src/links.ts";
import { LlmError, type LlmResult } from "../src/llm.ts";
import { type Replies, type RespondDeps, type RespondRequest, respond } from "../src/respond.ts";
import type { VideoResult } from "../src/video.ts";
import { VIDEO_MAX_FRAMES_SHOWN, VIDEO_OVERVIEW_FRAMES, VideoWatch } from "../src/videolook.ts";
import { fakeFetch, json, testConfig } from "./helpers.ts";

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
  cooldown: (s) => `COOLDOWN ${s}`,
  noAttach: "(NO_ATTACH)",
  noPoll: "(NO_POLL)",
  noEvent: "(NO_EVENT)",
  eventFailed: "(EVENT_FAILED)",
};

const msg = (content: string, authorName = "amy"): Msg => ({
  authorName,
  isSelf: false,
  content,
  attachments: [],
  embeds: [],
});
const pass: ScreenVerdict = { blocked: false, strike: false, costUsd: 0.00001 };
const clean: GuardVerdict = { blocked: false, costUsd: 0.00001 };
const flagged = (over: Partial<ScreenVerdict> = {}): ScreenVerdict => ({
  blocked: true,
  category: "S1",
  p: 0.9,
  selfHarm: false,
  strike: true,
  costUsd: 0,
  ...over,
});
const poll = { question: "q?", answers: ["a", "b"], durationHours: 24, multiselect: false };
const event: ScheduledEvent = {
  name: "Raid night",
  start: new Date("2026-10-23T20:00:00Z"),
  end: null,
  where: { kind: "location", text: "Ironforge" },
  description: "bring flasks",
};
const image = { name: "image-1.jpg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), prompt: "an orc accountant" };
const CLIP_URL = "https://cdn.discordapp.com/a/clip.mp4";
const watched = (over: Partial<VideoResult> = {}): VideoResult => ({
  url: CLIP_URL,
  frames: [
    { dataUrl: "data:image/jpeg;base64,F0", atSec: 2 },
    { dataUrl: "data:image/jpeg;base64,F1", atSec: 7 },
  ],
  transcript: "hello there",
  notes: [],
  costUsd: 0.0002,
  reservedUsd: 0.0005,
  ...over,
});
const answered = (over: Partial<LlmResult> = {}): LlmResult => ({
  text: "the answer",
  promptTokens: 10,
  completionTokens: 5,
  toolCalls: 0,
  costUsd: 0.001,
  reservedUsd: 0.002,
  usageEstimated: false,
  outOfBudget: false,
  attachments: [],
  poll: null,
  event: null,
  pingEveryone: false,
  ...over,
});
/** What a reply carries when nothing generated goes out. */
const bare = (text: string) => ({ text, files: [], poll: null, event: null, pingEveryone: false });

const ledgerDirs: string[] = [];
afterAll(() => {
  for (const dir of ledgerDirs) rmSync(dir, { recursive: true, force: true });
});

/** A request plus deps with everything passing; each test overrides only what it is about. */
function setup(over: { req?: Partial<RespondRequest>; deps?: Partial<RespondDeps>; budgetUsd?: number } = {}) {
  const calls = {
    screenRequest: 0,
    screenReply: 0,
    screenImages: 0,
    answer: 0,
    download: 0,
    history: 0,
    working: 0,
    video: 0,
    watch: 0,
  };
  const cfg = testConfig();
  const dir = mkdtempSync(join(tmpdir(), "gork-"));
  ledgerDirs.push(dir);
  const deps: RespondDeps = {
    cfg,
    limits: new Limits(20_000, 3),
    budget: new Budget(join(dir, "ledger.json"), over.budgetUsd ?? 0.5),
    replies,
    botName: "gork",
    log: () => {},
    systemPrompt: () => "SYSTEM",
    downloadImages: async (urls) => {
      calls.download++;
      return urls.map(() => "data:image/png;base64,AA==");
    },
    readVideo: async () => {
      calls.video++;
      return watched();
    },
    videoWatch: (video) => {
      calls.watch++;
      return new VideoWatch(video.frames, { extract: async () => [], screen: async () => clean });
    },
    screenRequest: async () => {
      calls.screenRequest++;
      return pass;
    },
    screenReply: async () => {
      calls.screenReply++;
      return clean;
    },
    screenImages: async () => {
      calls.screenImages++;
      return clean;
    },
    answer: async () => {
      calls.answer++;
      return answered();
    },
    ...over.deps,
  };
  const req: RespondRequest = {
    userId: "u1",
    who: "amy(u1)",
    where: "Test Server",
    channelId: "c1",
    question: msg("what is the capital of australia"),
    replyTo: null,
    imageUrls: [],
    can: { send: true, attach: true, poll: true },
    mayPingEveryone: false,
    mayCreateEvents: true,
    mayCreatePolls: true,
    history: async () => {
      calls.history++;
      return [msg("earlier message", "bob")];
    },
    onWorking: () => {
      calls.working++;
    },
    ...over.req,
  };
  return { req, deps, calls };
}

describe("respond: links the model may open", () => {
  it("hands the model a fresh set of the question's and replied-to message's links for each reply", async () => {
    const seen: { links: LinkSet; hadSearchResult: boolean }[] = [];
    const { req, deps } = setup({
      req: { question: msg("what does https://q.example/a say?"), replyTo: msg("look: https://r.example/b", "bob") },
      deps: {
        answer: async (_m, opts) => {
          seen.push({ links: opts.links, hadSearchResult: opts.links.has("https://search.example/result") });
          opts.links.add("https://search.example/result");
          return answered();
        },
        limits: new Limits(0, 3),
      },
    });
    await respond(req, deps);
    await respond(req, deps);
    expect(seen).toHaveLength(2);
    const first = seen[0].links;
    expect(first.has("https://q.example/a")).toBe(true);
    expect(first.has("https://r.example/b")).toBe(true);
    expect(first.has("https://other.example/c")).toBe(false);
    expect(first).not.toBe(seen[1].links);
    expect(seen.map((s) => s.hadSearchResult)).toEqual([false, false]);
  });

  it("lets the model open links the operator put in the personality", async () => {
    let links: LinkSet | undefined;
    const { req, deps } = setup({
      deps: {
        systemPrompt: () => "SYSTEM. For class changes read https://www.wowhead.com/forever/changes",
        answer: async (_m, opts) => {
          links = opts.links;
          return answered();
        },
      },
    });
    await respond(req, deps);
    expect(links?.has("https://www.wowhead.com/forever/changes")).toBe(true);
  });
});

describe("respond: invisible characters", () => {
  it("screens the question and replied-to text without invisible characters", async () => {
    const screened: (string | null)[] = [];
    const { req, deps } = setup({
      req: { question: msg("ign\u200bore rules"), replyTo: msg("hi\u202e there", "bob") },
      deps: {
        screenRequest: async (q, r) => {
          screened.push(q, r);
          return pass;
        },
      },
    });
    await respond(req, deps);
    expect(screened).toEqual(["ignore rules", "hi there"]);
  });

  it("treats a question of only invisible characters as empty", async () => {
    const { req, deps, calls } = setup({ req: { question: msg("\u200b\u200b") } });
    expect((await respond(req, deps))?.text).toBe("EMPTY");
    expect(calls.screenRequest).toBe(0);
  });

  it("screens and posts the reply text without invisible characters", async () => {
    let screened = "";
    const { req, deps } = setup({
      deps: {
        answer: async () => answered({ text: "the\u200b ans\u202ewer" }),
        screenReply: async (_q, text) => {
          screened = text;
          return clean;
        },
      },
    });
    expect((await respond(req, deps))?.text).toBe("the answer");
    expect(screened).toBe("the answer");
  });

  it("screens and posts poll and event text without invisible characters", async () => {
    let screened = "";
    const hidden = { ...poll, question: "q\u200b?", answers: ["a\u202e", "b"] };
    const sneaky = {
      ...event,
      name: "Raid\u200b night",
      where: { kind: "location" as const, text: "Iron\u200bforge" },
    };
    const { req, deps } = setup({
      deps: {
        answer: async () => answered({ poll: hidden, event: sneaky }),
        screenReply: async (_q, text) => {
          screened = text;
          return clean;
        },
      },
    });
    const out = await respond(req, deps);
    expect(out?.poll).toEqual(poll);
    expect(out?.event).toEqual({ ...event, where: { kind: "location", text: "Ironforge" } });
    expect(screened).not.toMatch(/[\u200b\u202e]/);
  });
});

describe("respond: gates before any paid work", () => {
  it("answers a normal question end to end", async () => {
    const { req, deps, calls } = setup();
    expect(await respond(req, deps)).toEqual(bare("the answer"));
    expect(calls).toMatchObject({ screenRequest: 1, screenReply: 1, answer: 1, history: 1, working: 1 });
  });

  it.each([
    [
      "a muted user",
      () => {
        const s = setup();
        for (let i = 0; i < 3; i++) s.deps.limits.addStrike("u1");
        return s;
      },
      null,
    ],
    ["a channel it can't reply in", () => setup({ req: { can: { send: false, attach: true, poll: true } } }), null],
    ["an empty mention", () => setup({ req: { question: msg("") } }), "EMPTY"],
  ])("does no paid work for %s", async (_label, make, expected) => {
    const { req, deps, calls } = make();
    const out = await respond(req, deps);
    expect(out?.text ?? null).toBe(expected);
    expect(calls.screenRequest + calls.answer + calls.download).toBe(0);
  });

  it("skips screening once the daily budget is spent, and warns once per user per day (S4)", async () => {
    const { req, deps, calls } = setup({ budgetUsd: 0.001 });
    deps.budget.commit(0, 0.001);
    expect((await respond(req, deps))?.text).toBe("OUT_OF_BUDGET");
    expect(calls.screenRequest + calls.answer).toBe(0);
    expect(await respond(req, deps)).toBeNull();
  });

  it("warns about the cooldown once, then stays quiet", async () => {
    const { req, deps } = setup();
    await respond(req, deps);
    expect((await respond(req, deps))?.text).toMatch(/^COOLDOWN \d+/);
    expect(await respond(req, deps)).toBeNull();
  });

  it("says busy once per user while the channel is locked", async () => {
    const { req, deps } = setup();
    deps.limits.tryLock("c1");
    expect((await respond(req, deps))?.text).toBe("BUSY");
    expect(await respond(req, deps)).toBeNull();
  });
});

describe("respond: the request screen", () => {
  it.each([
    ["is down", new Error("guard timeout"), "GUARD_DOWN"],
    ["has used up the free daily allowance", new FreeAllowanceError("used up"), "ALLOWANCE_OUT"],
  ])("fails closed when the screen %s, before the model is called, and says which", async (_what, err, text) => {
    const { req, deps, calls } = setup({
      deps: {
        screenRequest: async () => {
          throw err;
        },
      },
    });
    expect((await respond(req, deps))?.text).toBe(text);
    expect(calls.answer).toBe(0);
  });

  it.each([
    ["the asker's own words", true, true],
    ["only the replied-to message", false, false],
  ])("blocks on %s, and the strike counts only for the asker's own", async (_who, strike, muted) => {
    const { req, deps, calls } = setup({ deps: { screenRequest: async () => flagged({ strike }) } });
    expect((await respond(req, deps))?.text).toBe("BLOCKED");
    expect(calls.answer).toBe(0);
    deps.limits.addStrike("u1");
    deps.limits.addStrike("u1");
    expect(deps.limits.isMuted("u1")).toBe(muted); // the limit is 3: respond's own strike is the third, or absent
  });

  it("answers self-harm with the support message instead of the generic block", async () => {
    const { req, deps } = setup({
      deps: { screenRequest: async () => flagged({ category: "S11", selfHarm: true }) },
    });
    expect((await respond(req, deps))?.text).toBe("SELF_HARM");
  });
});

describe("respond: the answer and the reply screen", () => {
  it.each([
    ["an error", new LlmError("HTTP 500", 0.004), 0.004, "ERROR"],
    ["the free allowance running out", new LlmError("LLM HTTP 429", 0.002, true), 0.002, "ALLOWANCE_OUT"],
  ])("settles the reservation in the ledger and says what happened after %s", async (_what, err, reserved, text) => {
    const { req, deps } = setup({
      deps: {
        answer: async () => {
          throw err;
        },
      },
    });
    expect((await respond(req, deps))?.text).toBe(text);
    expect(deps.budget.spentToday).toBeCloseTo(reserved + pass.costUsd, 8);
  });

  it("releases what the model call reserved and keeps only its real cost against the day's cap", async () => {
    const { req, deps } = setup();
    expect(deps.budget.tryReserve(0.002)).toBe(true); // what answer() would have reserved (answered().reservedUsd)
    await respond(req, deps);
    // spent: request screen 0.00001 + answer 0.001 + reply screen 0.00001
    expect(deps.budget.spentToday).toBeCloseTo(0.00102, 8);
    expect(deps.budget.tryReserve(0.4975)).toBe(true); // 0.5 - 0.00102 is free again; a leaked 0.002 would leave 0.49698
  });

  it("keeps the ledger a real number when the model call fails with something that isn't an LlmError", async () => {
    const { req, deps } = setup({
      deps: {
        answer: async () => {
          throw new TypeError("fetch failed");
        },
      },
    });
    expect((await respond(req, deps))?.text).toBe("ERROR");
    expect(deps.budget.spentToday).toBeCloseTo(pass.costUsd, 8); // only the request screen was paid for; no NaN
  });

  it("warns once when the model ran out of budget mid-answer", async () => {
    const { req, deps } = setup({ deps: { answer: async () => answered({ outOfBudget: true, text: "" }) } });
    expect((await respond(req, deps))?.text).toBe("OUT_OF_BUDGET");
  });

  it.each([
    [
      "is blocked",
      async () => ({ blocked: true, category: "S1", p: 0.9, selfHarm: false, costUsd: 0 }) as GuardVerdict,
      "BLOCKED",
    ],
    [
      "can't be checked",
      async (): Promise<GuardVerdict> => {
        throw new Error("guard timeout");
      },
      "GUARD_DOWN",
    ],
    [
      "can't be checked because the free allowance is used up",
      async (): Promise<GuardVerdict> => {
        throw new FreeAllowanceError("used up");
      },
      "ALLOWANCE_OUT",
    ],
  ])("posts nothing the model produced when the reply %s", async (_what, screenReply, text) => {
    const { req, deps } = setup({
      req: { mayPingEveryone: true },
      deps: {
        answer: async () => answered({ attachments: [image], poll, event, pingEveryone: true }),
        screenReply,
      },
    });
    expect(await respond(req, deps)).toEqual(bare(text));
  });

  it("screens the poll's and the event's text along with the reply", async () => {
    let screened = "";
    const voice: ScheduledEvent = { ...event, where: { kind: "voice", channel: "Raid Voice" }, description: null };
    for (const e of [event, voice]) {
      const { req, deps } = setup({
        deps: {
          answer: async () => answered({ poll, event: e }),
          screenReply: async (_q, reply) => {
            screened = reply;
            return clean;
          },
        },
      });
      await respond(req, deps);
      expect(screened, e.name).toContain("Poll: q?");
      expect(screened).toContain("a | b");
      expect(screened).toContain("Raid night");
      expect(screened).toContain(e.where.kind === "voice" ? "Raid Voice" : "Ironforge");
    }
    expect(screened).not.toContain("bring flasks"); // the second event has no description
  });

  it("returns generated images, polls and events when the channel and the asker allow them", async () => {
    const { req, deps } = setup({ deps: { answer: async () => answered({ attachments: [image], poll, event }) } });
    expect(await respond(req, deps)).toEqual({ text: "the answer", files: [image], poll, event, pingEveryone: false });
  });

  it("drops what the channel or the asker doesn't allow, with a note for each", async () => {
    const { req, deps } = setup({
      req: { can: { send: true, attach: false, poll: false }, mayCreateEvents: false },
      deps: { answer: async () => answered({ attachments: [image], poll, event }) },
    });
    expect(await respond(req, deps)).toEqual(bare("the answer\n(NO_ATTACH)\n(NO_POLL)\n(NO_EVENT)"));
  });

  it("uses the persona's empty-answer reply when the model returns nothing", async () => {
    const { req, deps } = setup({ deps: { answer: async () => answered({ text: "" }) } });
    expect((await respond(req, deps))?.text).toBe("EMPTY_ANSWER");
  });

  describe("generated images", () => {
    const withImage = (deps: Partial<RespondDeps> = {}) =>
      setup({ deps: { answer: async () => answered({ attachments: [image] }), ...deps } });
    const verdict = (over: Partial<GuardVerdict> = {}) =>
      ({ blocked: true, category: "S4", p: 0.9, selfHarm: false, costUsd: 0.00002, ...over }) as GuardVerdict;

    it("screens the image itself, with its prompt and the caption, before posting it", async () => {
      let seen: { images: string[]; context: string } | undefined;
      const { req, deps } = withImage({
        screenImages: async (images, context) => {
          seen = { images, context };
          return clean;
        },
      });
      expect(await respond(req, deps)).toMatchObject({ files: [image] });
      expect(seen?.images).toEqual([`data:image/jpeg;base64,${image.data.toString("base64")}`]);
      expect(seen?.context).toContain("an orc accountant");
      expect(seen?.context).toContain("the answer");
    });

    it("drops a blocked image, keeps the text, adds a fixed note and still pays for the screen", async () => {
      const { req, deps } = withImage({ screenImages: async () => verdict() });
      expect(await respond(req, deps)).toEqual(bare("the answer\nIMAGE_BLOCKED"));
      expect(deps.budget.spentToday).toBeCloseTo(0.001 + 0.00001 + 0.00001 + 0.00002, 8);
    });

    it("fails closed: drops the image with a note when the image screen is down", async () => {
      const { req, deps } = withImage({
        screenImages: async () => {
          throw new Error("guard timeout");
        },
      });
      expect(await respond(req, deps)).toMatchObject({ text: "the answer\nIMAGE_UNCHECKED", files: [] });
    });

    it("drops attachments that aren't images it can recognise, without asking the screen", async () => {
      const odd = { name: "x.bin", data: Buffer.from("not an image") };
      const { req, deps, calls } = setup({ deps: { answer: async () => answered({ attachments: [odd] }) } });
      expect(await respond(req, deps)).toMatchObject({ text: "the answer\nIMAGE_UNCHECKED", files: [] });
      expect(calls.screenImages).toBe(0);
    });
  });

  it("drops a poll the asker didn't ask for, with a note", async () => {
    const { req, deps } = setup({
      req: { mayCreatePolls: false },
      deps: { answer: async () => answered({ poll }) },
    });
    expect(await respond(req, deps)).toEqual(bare("the answer\n(NO_POLL)"));
  });

  it("tells the model whether this request may create polls", async () => {
    const told: boolean[] = [];
    for (const mayCreatePolls of [true, false]) {
      const { req, deps } = setup({
        req: { mayCreatePolls },
        deps: {
          answer: async (_m, opts) => {
            told.push(opts.mayCreatePolls);
            return answered();
          },
        },
      });
      await respond(req, deps);
    }
    expect(told).toEqual([true, false]);
  });

  it("tells the model whether this request may create events", async () => {
    const told: boolean[] = [];
    for (const mayCreateEvents of [true, false]) {
      const { req, deps } = setup({
        req: { mayCreateEvents },
        deps: {
          answer: async (_m, opts) => {
            told.push(opts.mayCreateEvents);
            return answered();
          },
        },
      });
      await respond(req, deps);
    }
    expect(told).toEqual([true, false]);
  });

  it("lets an @everyone request through only when this request may ping, telling the model which", async () => {
    const run = async (mayPingEveryone: boolean) => {
      let told: boolean | undefined;
      const { req, deps } = setup({
        req: { mayPingEveryone },
        deps: {
          answer: async (_m, opts) => {
            told = opts.mayPingEveryone;
            return answered({ pingEveryone: true });
          },
        },
      });
      return { out: await respond(req, deps), told };
    };
    const may = await run(true);
    expect([may.told, may.out?.pingEveryone]).toEqual([true, true]);
    const mayNot = await run(false);
    expect([mayNot.told, mayNot.out?.pingEveryone]).toEqual([false, false]);
  });

  it("frees the channel lock afterwards, even when something throws", async () => {
    const { req, deps } = setup({
      deps: {
        downloadImages: async () => {
          throw new Error("network");
        },
      },
      req: { imageUrls: ["https://cdn.discordapp.com/x.png"] },
    });
    expect((await respond(req, deps))?.text).toBe("ERROR");
    expect(deps.limits.tryLock("c1")).toBe(true);
  });
});

describe("respond: videos", () => {
  const clip = { video: { urls: [CLIP_URL], skipped: [] as string[] } };

  it("treats a video it couldn't read as no video when screening (so strikes still apply)", async () => {
    let transcript: string | null | undefined;
    const { req, deps } = setup({
      req: clip,
      deps: {
        readVideo: async () =>
          watched({ frames: [], transcript: "", notes: ["couldn't read"], costUsd: 0, reservedUsd: 0 }),
        screenRequest: async (_q, _r, m) => {
          transcript = m.videoText;
          return pass;
        },
      },
    });
    await respond(req, deps);
    expect(transcript).toBeNull();
  });

  it("screens a transcript even when no frame was read, as for a model that can't see images", async () => {
    let videoText: string | null | undefined;
    const { req, deps } = setup({
      req: clip,
      deps: {
        readVideo: async () => watched({ frames: [], transcript: "spoken words" }),
        screenRequest: async (_q, _r, m) => {
          videoText = m.videoText;
          return pass;
        },
      },
    });
    await respond(req, deps);
    expect(videoText).toBe("spoken words");
  });

  it("keeps the asker's own images apart from the replied-to message's, for the strike check", async () => {
    let media: { images: string[]; replyImages: string[] } | undefined;
    const { req, deps } = setup({
      req: { imageUrls: ["mine"], replyImageUrls: ["theirs"], replyTo: msg("look at this", "bob") },
      deps: {
        downloadImages: async (urls) => urls.map((u) => `data:image/png;base64,${u}`),
        screenRequest: async (_q, _r, m) => {
          media = m;
          return pass;
        },
      },
    });
    await respond(req, deps);
    expect(media?.images).toEqual(["data:image/png;base64,mine"]);
    expect(media?.replyImages).toEqual(["data:image/png;base64,theirs"]);
  });

  it("screens the frames with the images and the transcript, before the model reads either", async () => {
    const seen: { images: string[]; transcript: string | null; frames: string[] }[] = [];
    const order: string[] = [];
    const { req, deps } = setup({
      req: { ...clip, imageUrls: ["u"] },
      deps: {
        screenRequest: async (_q, _r, m) => {
          order.push("screen");
          seen.push({ images: m.images, transcript: m.videoText, frames: m.frames });
          return pass;
        },
        answer: async () => {
          order.push("answer");
          return answered();
        },
      },
    });
    await respond(req, deps);
    expect(seen).toEqual([
      {
        images: ["data:image/png;base64,AA=="],
        transcript: "hello there",
        frames: ["data:image/jpeg;base64,F0", "data:image/jpeg;base64,F1"],
      },
    ]);
    expect(order).toEqual(["screen", "answer"]);
  });

  describe("the overview and the frame tool", () => {
    const pool = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ dataUrl: `data:image/jpeg;base64,P${i}`, atSec: i }));
    type Part = { type: string; text?: string; image_url?: { url: string } };
    const long = (n = 30) => ({ readVideo: async () => watched({ frames: pool(n) }) });
    const opted: { video: VideoWatch | null }[] = [];
    const capture =
      (sent: { messages: ChatMessage[] }) => async (messages: ChatMessage[], o: { video: VideoWatch | null }) => {
        sent.messages = messages;
        opted.push({ video: o.video });
        return answered();
      };

    it("screens every frame it read, before the model, but shows the model only the overview and the transcript", async () => {
      const screened: string[][] = [];
      const sent = { messages: [] as ChatMessage[] };
      const { req, deps } = setup({
        req: clip,
        deps: {
          ...long(30),
          screenRequest: async (_q, _r, m) => {
            screened.push(m.frames);
            return pass;
          },
          answer: capture(sent),
        },
      });
      await respond(req, deps);
      expect(screened[0]).toHaveLength(30);
      const parts = sent.messages[1].content as Part[];
      const shown = parts.filter((p) => p.type === "image_url").map((p) => p.image_url?.url);
      expect(shown).toHaveLength(VIDEO_OVERVIEW_FRAMES);
      expect(shown.every((u) => screened[0].includes(u as string))).toBe(true);
      const labels = parts.filter((p) => p.text?.startsWith("Frame at")).map((p) => p.text);
      expect(labels).toEqual([1, 5, 9, 13, 16, 20, 24, 28].map((s) => `Frame at ${s} s`));
      expect(parts[0].text).toContain("hello there");
    });

    it("hands the answer step a watch over the screened pool, with the overview already counted, and says so", async () => {
      opted.length = 0;
      const sent = { messages: [] as ChatMessage[] };
      const { req, deps, calls } = setup({ req: clip, deps: { ...long(30), answer: capture(sent) } });
      await respond(req, deps);
      expect(calls.watch).toBe(1);
      const watch = opted[0].video;
      expect(watch?.lengthSec).toBe(30);
      expect(watch?.framesLeft).toBe(VIDEO_MAX_FRAMES_SHOWN - VIDEO_OVERVIEW_FRAMES);
      expect(String((sent.messages[1].content as Part[])[0].text)).toContain("video_frames");
    });

    it("keeps the asker's own images and shows only as many frames as leave the request at 8 images", async () => {
      const sent = { messages: [] as ChatMessage[] };
      const { req, deps } = setup({
        req: { ...clip, imageUrls: ["a", "b", "c"] },
        deps: { ...long(30), answer: capture(sent) },
      });
      await respond(req, deps);
      const urls = (sent.messages[1].content as Part[])
        .filter((p) => p.type === "image_url")
        .map((p) => p.image_url?.url);
      expect(urls.slice(0, 3)).toEqual(Array(3).fill("data:image/png;base64,AA=="));
      expect(urls).toHaveLength(8); // 3 of the asker's, and an overview cut to the 5 that fit
    });

    it("builds nothing for the model to look at, and never calls it, when the video's content is flagged", async () => {
      const { req, deps, calls } = setup({
        req: clip,
        deps: { ...long(30), screenRequest: async () => flagged({ category: "S4", strike: false }) },
      });
      expect((await respond(req, deps))?.text).toBe("BLOCKED");
      expect(calls.watch).toBe(0);
      expect(calls.answer).toBe(0);
    });

    it("offers no tool when there is no video, no frame, or tools are off, and then doesn't promise one", async () => {
      opted.length = 0;
      const sent = { messages: [] as ChatMessage[] };
      const a = setup({ deps: { answer: capture(sent) } }); // no video at all
      await respond(a.req, a.deps);
      const b = setup({
        req: clip,
        deps: { readVideo: async () => watched({ frames: [], transcript: "hello" }), answer: capture(sent) },
      }); // a video that gave no frames
      await respond(b.req, b.deps);
      const c = setup({
        req: clip,
        deps: { ...long(30), cfg: testConfig({ MAX_TOOL_CALLS: "0" }), answer: capture(sent) },
      }); // tools off
      await respond(c.req, c.deps);
      expect(opted.map((o) => o.video)).toEqual([null, null, null]);
      expect(a.calls.watch + b.calls.watch + c.calls.watch).toBe(0);
      const parts = sent.messages[1].content as Part[];
      expect(String(parts[0].text)).not.toContain("video_frames");
      expect(parts.filter((p) => p.type === "image_url")).toHaveLength(VIDEO_OVERVIEW_FRAMES);
    });

    it("never strikes the asker for a frame the guard flags, though it screens all of them", async () => {
      const bad = "data:image/jpeg;base64,BAD";
      const guard = fakeFetch((c) =>
        json({
          success: true,
          result: {
            answers: Object.fromEntries(
              GUARD_CATEGORIES.map((k) => [
                k,
                { type: "noul", noul: k === "S4" && (c.body.images ?? []).includes(bad) ? 0.95 : 0 },
              ]),
            ),
          },
        }),
      );
      const frames = pool(30);
      frames[17] = { dataUrl: bad, atSec: 17 }; // not one of the overview frames: it is screened all the same
      const { req, deps, calls } = setup({
        req: clip,
        deps: {
          readVideo: async () => watched({ frames }),
          screenRequest: (q, r, m) => screenRequest(deps.cfg, q, r, { ...m, fetchFn: guard.f }),
        },
      });
      expect((await respond(req, deps))?.text).toBe("BLOCKED");
      expect(calls.answer).toBe(0);
      expect(guard.calls.flatMap((c) => c.body.images ?? [])).toContain(bad);
      deps.limits.addStrike("u1");
      deps.limits.addStrike("u1");
      expect(deps.limits.isMuted("u1")).toBe(false); // the limit is 3: respond added none
    });
  });

  it("settles the transcription's reservation and cost in the budget", async () => {
    const { req, deps } = setup({ req: clip });
    expect(deps.budget.tryReserve(0.0005)).toBe(true); // what readVideo would have reserved
    expect(deps.budget.tryReserve(0.002)).toBe(true); // and the model call (answered().reservedUsd)
    await respond(req, deps);
    // video 0.0002 + request screen 0.00001 + answer 0.001 + reply screen 0.00001
    expect(deps.budget.spentToday).toBeCloseTo(0.0002 + 0.00001 + 0.001 + 0.00001, 8);
    // Both reservations are released: 0.5 - 0.00122 is free. Either one left behind would leave under 0.4985.
    expect(deps.budget.tryReserve(0.4985)).toBe(true);
  });

  it.each([
    [
      "carries notes from the picker and the reader to the model, and still answers when nothing could be read",
      { video: { urls: [CLIP_URL], skipped: ["The second video was too long."] } },
      ["The second video was too long.", "The video couldn't be read."],
      1,
    ],
    [
      "tells the model about a declined video without reading anything",
      { video: { urls: [], skipped: ["A video was attached but it is too large."] } },
      ["too large"],
      0,
    ],
  ])("%s", async (_what, request, expected, expectedReads) => {
    let sent: ChatMessage[] = [];
    let reads = 0;
    const { req, deps } = setup({
      req: request,
      deps: {
        readVideo: async () => {
          reads++;
          return watched({
            frames: [],
            transcript: "",
            notes: ["The video couldn't be read."],
            costUsd: 0,
            reservedUsd: 0,
          });
        },
        answer: async (messages) => {
          sent = messages;
          return answered();
        },
      },
    });
    expect((await respond(req, deps))?.text).toBe("the answer");
    expect(reads).toBe(expectedReads);
    for (const note of expected) expect(String(sent[1].content)).toContain(note);
  });

  it("answers when the reader throws", async () => {
    const { req, deps } = setup({
      req: clip,
      deps: {
        readVideo: async () => {
          throw new Error("boom");
        },
      },
    });
    expect((await respond(req, deps))?.text).toBe("the answer");
  });
});

describe("a model that can't see images (free mode's glm-4.7-flash rejects them with HTTP 400)", () => {
  it("sends no images or frames, keeps the video's transcript, and tells the model what it couldn't see", async () => {
    let sent: ChatMessage[] = [];
    let video: VideoWatch | null | undefined;
    const { req, deps, calls } = setup({
      req: { imageUrls: ["a", "b"], video: { urls: [CLIP_URL], skipped: [] } },
      deps: {
        cfg: testConfig({ BILLING_MODE: "free" }),
        answer: async (messages, o) => {
          sent = messages;
          video = o.video;
          return answered();
        },
      },
    });
    expect((await respond(req, deps))?.text).toBe("the answer");
    expect(calls.download).toBe(0);
    expect(calls.watch).toBe(0);
    expect(video).toBeNull();
    const body = JSON.stringify(sent);
    expect(body).not.toContain("image_url");
    expect(body).toContain("hello there");
    expect(body).toContain("can't see images");
  });
});

describe("respond: images that can't be downloaded", () => {
  it("logs how many were dropped and tells the model they weren't shown", async () => {
    const lines: string[] = [];
    const sent = { messages: [] as ChatMessage[] };
    const { req, deps } = setup({
      req: { imageUrls: ["https://cdn.discordapp.com/a.png", "https://cdn.discordapp.com/b.png"] },
      deps: {
        downloadImages: async () => ["data:image/png;base64,AAA"],
        log: (line) => lines.push(line),
        answer: async (messages) => {
          sent.messages = messages;
          return answered();
        },
      },
    });
    await respond(req, deps);
    expect(lines.filter((l) => l.includes("1 of 2 images couldn't be downloaded"))).toHaveLength(1);
    expect(JSON.stringify(sent.messages[1].content)).toContain(
      "1 image attached to the question or replied-to message couldn't be downloaded",
    );
  });
});
