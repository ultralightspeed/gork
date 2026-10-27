import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.ts";
import type { Msg } from "../src/context.ts";
import { EarlierImages } from "../src/earlierimages.ts";
import { screenEarlierImages, screenImages, screenReply, screenRequest } from "../src/guard.ts";
import { downloadImages } from "../src/images.ts";
import { Limits } from "../src/limits.ts";
import { answer } from "../src/llm.ts";
import { type Replies, type RespondDeps, type RespondRequest, respond } from "../src/respond.ts";
import { newToolState, runTool } from "../src/tools.ts";
import { type Call, fakeFetch, json, testConfig } from "./helpers.ts";

// Someone posts an image, and the next message asks gork about it without replying to it: the report was that gork
// answered "what image?". The whole reply runs through the real model loop, the real view_images tool, the real image
// download and the real guard calls, with only the network faked.

const IMAGE_URL = "https://media.discordapp.net/attachments/1/2/screenshot.png";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const IMAGE_DATA = `data:image/png;base64,${PNG.toString("base64")}`;

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
const msg = (authorName: string, content: string, images: string[] = []): Msg => ({
  authorName,
  isSelf: false,
  content,
  attachments: [],
  embeds: [],
  images,
});
const completion = (message: object) =>
  json({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
const viewCall = (numbers: number[]) => ({
  content: null,
  tool_calls: [
    { id: "c1", type: "function", function: { name: "view_images", arguments: JSON.stringify({ numbers }) } },
  ],
});
type Part = { type: string; text?: string; image_url?: { url: string } };

async function reply(o: { modelAsks?: boolean; flagImage?: boolean; config?: Record<string, string> } = {}) {
  const cfg = testConfig(o.config ?? {});
  const chat = [
    () => (o.modelAsks === false ? completion({ content: "Canberra." }) : completion(viewCall([1]))),
    () => completion({ content: "A screenshot of the raid frames: everyone is dead but the hunter." }),
  ];
  const cf = fakeFetch((c: Call) => {
    if (c.url.endsWith("/chat/completions")) return (chat.shift() ?? (() => completion({ content: "done" })))();
    if (c.url.includes("clef-flash")) {
      const flagged = o.flagImage && (c.body.images ?? []).includes(IMAGE_DATA);
      const answers = Object.fromEntries(
        ["S1", "S3", "S4", "S9", "S11"].map((k) => [k, { type: "noul", noul: flagged && k === "S4" ? 0.95 : 0 }]),
      );
      return json({ success: true, result: { answers } });
    }
    if (c.url === IMAGE_URL) return new Response(PNG, { headers: { "content-type": "image/png" } });
    return json({ error: "unexpected" }, 500);
  });
  const state = newToolState(cfg);
  const deps: RespondDeps = {
    cfg,
    limits: new Limits(0, 3),
    budget: new Budget(join(mkdtempSync(join(tmpdir(), "gork-")), "ledger.json"), 1),
    replies,
    botName: "gork",
    log: () => {},
    systemPrompt: () => "SYSTEM",
    downloadImages: (urls) => downloadImages(urls, cf.f),
    readVideo: async () => {
      throw new Error("no video here");
    },
    videoWatch: () => {
      throw new Error("no video here");
    },
    earlierImages: (images, room) =>
      new EarlierImages(
        images,
        {
          download: async (url) => (await downloadImages([url], cf.f))[0] ?? null,
          screen: (shown) => screenEarlierImages(cfg, shown, { fetchFn: cf.f }),
        },
        room,
      ),
    screenRequest: (q, r, media) => screenRequest(cfg, q, r, { ...media, fetchFn: cf.f }),
    screenReply: (q, text) => screenReply(cfg, q, text, { fetchFn: cf.f }),
    screenImages: (images, context) => screenImages(cfg, images, context, { fetchFn: cf.f }),
    answer: (messages, { video, earlierImages }) =>
      answer(cfg, messages, {
        fetch: cf.f,
        reserve: (usd) => deps.budget.tryReserve(usd),
        offer: { video: !!video, earlierImages: !!earlierImages },
        runTool: (name, args, tally, turn) =>
          runTool(cfg, name, args, {
            state,
            tally,
            fetch: cf.f,
            video: video ?? undefined,
            earlierImages: earlierImages ?? undefined,
            reserve: turn.reserve,
            deadline: turn.deadline,
          }),
      }),
  };
  const req: RespondRequest = {
    userId: "u1",
    who: "zed(u1)",
    where: "Test Server",
    channelId: "c1",
    question: msg("zed", "what is this?"),
    replyTo: null,
    imageUrls: [],
    can: { send: true, attach: true, poll: true },
    mayPingEveryone: false,
    mayCreateEvents: false,
    mayCreatePolls: false,
    history: async () => [msg("wicket", "anyone up for MC tonight"), msg("zed", "", [IMAGE_URL])],
  };
  const outcome = await respond(req, deps);
  const modelCalls = cf.calls.filter((c) => c.url.endsWith("/chat/completions"));
  const guardCalls = cf.calls.filter((c) => c.url.includes("clef-flash"));
  const downloads = cf.calls.filter((c) => c.url === IMAGE_URL);
  return { outcome, modelCalls, guardCalls, downloads, all: cf.calls };
}

const lead = (c: Call) => {
  const content = c.body.messages[1].content;
  return typeof content === "string" ? content : ((content as Part[])[0].text ?? "");
};

describe("asking about an image posted earlier in the chat, end to end", () => {
  it("lets the model look at it by the number its line shows, and answers from it", async () => {
    const { outcome, modelCalls } = await reply();
    expect(outcome?.text).toBe("A screenshot of the raid frames: everyone is dead but the hunter.");
    expect(modelCalls).toHaveLength(2);

    // First call: the history line numbers the image, and the tool is on offer.
    expect(lead(modelCalls[0])).toContain("zed: [image #1]");
    expect(modelCalls[0].body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain(
      "view_images",
    );

    // Second call: assistant, tool result, then one user message holding the image after its label.
    const tail = modelCalls[1].body.messages.slice(2);
    expect(tail.map((m: { role: string }) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(tail[1].content).toMatch(/untrusted/);
    const follow = tail[2].content as Part[];
    expect(follow.filter((p) => p.type === "image_url").map((p) => p.image_url?.url)).toEqual([IMAGE_DATA]);
    expect(follow.map((p) => p.text)).toContain("Image #1, posted by zed");
  });

  it("screens the image after downloading it and before the model sees it, with no strike", async () => {
    const { all } = await reply();
    const at = (pred: (c: Call) => boolean) => all.map(pred).flatMap((x, i) => (x ? [i] : []));
    const model = at((c) => c.url.endsWith("/chat/completions"));
    const [download] = at((c) => c.url === IMAGE_URL);
    const [screen] = at((c) => c.url.includes("clef-flash") && (c.body.images ?? []).includes(IMAGE_DATA));
    expect(model[0]).toBeLessThan(download);
    expect(download).toBeLessThan(screen);
    expect(screen).toBeLessThan(model[1]);
  });

  it("downloads and screens nothing when the model doesn't ask to see it", async () => {
    const { outcome, downloads, guardCalls } = await reply({ modelAsks: false });
    expect(outcome?.text).toBe("Canberra.");
    expect(downloads).toHaveLength(0);
    expect(guardCalls.every((c) => !c.body.images)).toBe(true);
  });

  it("shows no image, and still answers, when the screen flags it", async () => {
    const { outcome, modelCalls } = await reply({ flagImage: true });
    expect(outcome?.text).toBe("A screenshot of the raid frames: everyone is dead but the hunter.");
    const tail = modelCalls[1].body.messages.slice(2);
    expect(tail.map((m: { role: string }) => m.role)).toEqual(["assistant", "tool"]);
    expect(tail[1].content).toContain("Image #1 can't be shown");
    expect(JSON.stringify(modelCalls[1].body.messages)).not.toContain(IMAGE_DATA);
  });

  it.each([
    ["tool calls are switched off", { MAX_TOOL_CALLS: "0" }],
    ["the model can't see images", { BILLING_MODE: "free" }],
  ])("offers no tool, and says the image isn't shown, when %s", async (_why, config) => {
    const { modelCalls, downloads } = await reply({ config });
    expect(lead(modelCalls[0])).toContain("zed: [image, not shown]");
    const tools = (modelCalls[0].body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
    expect(tools).not.toContain("view_images");
    expect(downloads).toHaveLength(0);
  });
});
