import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { Budget } from "../src/budget.ts";
import { FREE_MODEL } from "../src/config.ts";
import type { Msg } from "../src/context.ts";
import { screenImages, screenReply, screenRequest } from "../src/guard.ts";
import { Limits } from "../src/limits.ts";
import { answer, LlmError } from "../src/llm.ts";
import { type RespondDeps, type RespondRequest, respond } from "../src/respond.ts";
import { newToolState, runTool, toolDefs } from "../src/tools.ts";
import { type Call, fakeFetch, json, NO_LIMITS, testConfig } from "./helpers.ts";

const FREE = { BILLING_MODE: "free" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const clean = { S1: 0, S3: 0, S4: 0, S9: 0, S11: 0 };
const toolCall = (id: string, name: string, args: object) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (message: object) =>
  json({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } });

/** Cloudflare as far as one reply can see it: a scripted model, Browser Run, FLUX and the safety screen. */
function cloudflare(chat: Array<() => Response>) {
  return fakeFetch((c: Call) => {
    if (c.url.endsWith("/ai/v1/chat/completions")) return (chat.shift() ?? (() => completion({ content: "done" })))();
    if (c.url.endsWith("/browser-rendering/markdown")) return json({ success: true, result: "# A page" });
    if (c.url.includes("flux-1-schnell")) return json({ success: true, result: { image: JPEG.toString("base64") } });
    if (c.url.includes("clef-flash")) {
      const answers = Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, { type: "noul", noul: v }]));
      return json({ success: true, result: { answers } });
    }
    return json({ error: "unexpected" }, 500);
  });
}

const msg = (content: string): Msg => ({ authorName: "amy", isSelf: false, content, attachments: [], embeds: [] });

/** A whole reply through the real model loop, tools and safety screens, with only the network faked. */
async function fullReply(env: Record<string, string>) {
  const cfg = testConfig(env);
  const { f, calls } = cloudflare([
    () =>
      completion({
        content: null,
        tool_calls: [
          toolCall("c1", "web_fetch", { url: "https://example.com/news" }),
          toolCall("c2", "generate_image", { prompt: "a tidy orc accountant at a desk" }),
        ],
      }),
    () => completion({ content: "Read the page and drew you something." }),
  ]);
  const state = newToolState(cfg);
  const dir = mkdtempSync(join(tmpdir(), "gork-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const deps: RespondDeps = {
    cfg,
    limits: new Limits(0, 3),
    budget: new Budget(join(dir, "ledger.json"), 1),
    replies: {
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
    },
    botName: "gork",
    log: () => {},
    systemPrompt: () => "SYSTEM",
    downloadImages: async () => [],
    readVideo: async () => {
      throw new Error("no video in this request");
    },
    videoWatch: () => {
      throw new Error("no video in this request");
    },
    screenRequest: (q, r, media) => screenRequest(cfg, q, r, { ...media, fetchFn: f }),
    screenReply: (q, text) => screenReply(cfg, q, text, { fetchFn: f }),
    screenImages: (images, context) => screenImages(cfg, images, context, { fetchFn: f }),
    answer: (messages, { links }) =>
      answer(cfg, messages, {
        fetch: f,
        reserve: (usd) => deps.budget.tryReserve(usd),
        runTool: (name, args, tally, turn) =>
          runTool(cfg, name, args, { state, tally, fetch: f, links, reserve: turn.reserve, deadline: turn.deadline }),
      }),
  };
  const req: RespondRequest = {
    userId: "u1",
    who: "amy(u1)",
    where: "Test Server",
    channelId: "c1",
    question: msg("what's in https://example.com/news? and draw me an orc"),
    replyTo: null,
    imageUrls: [],
    can: { send: true, attach: true, poll: true },
    mayPingEveryone: false,
    mayCreateEvents: false,
    mayCreatePolls: false,
    history: async () => [],
  };
  const outcome = await respond(req, deps);
  return { outcome, calls };
}

const gatewayHeaders = (c: Call) => Object.keys(c.headers).filter((h) => /^cf-aig-/i.test(h));

describe("BILLING_MODE=free never touches the gateway or unified billing", () => {
  it("sends no request to gateway.ai.cloudflare.com and no cf-aig-* header across a full reply with a tool round", async () => {
    const { outcome, calls } = await fullReply(FREE);
    expect(outcome?.text).toBe("Read the page and drew you something.");
    expect(outcome?.files).toHaveLength(1);
    const urls = calls.map((c) => c.url);
    // The reply really exercised every networked path: model, page read, image, and the safety screens.
    expect(urls.filter((u) => u.endsWith("/ai/v1/chat/completions"))).toHaveLength(2);
    expect(urls.some((u) => u.endsWith("/browser-rendering/markdown"))).toBe(true);
    expect(urls.some((u) => u.includes("flux-1-schnell"))).toBe(true);
    expect(urls.filter((u) => u.includes("clef-flash")).length).toBeGreaterThanOrEqual(3);
    // The model goes straight to Workers AI and is the free one.
    expect(calls.find((c) => c.url.endsWith("/ai/v1/chat/completions"))?.body.model).toBe(FREE_MODEL);
    for (const c of calls) {
      // Web Search reaches the gateway through a body field, so look there too.
      expect(JSON.stringify(c.body ?? {}), c.url).not.toMatch(/"gateway"/);
      expect(c.url, c.url).not.toContain("gateway.ai.cloudflare.com");
      expect(gatewayHeaders(c), c.url).toEqual([]);
      expect(c.url, c.url).toMatch(
        /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/0123456789abcdef0123456789abcdef\//,
      );
    }
  });

  it("the same check does see the gateway header in credits mode, so the test can fail", async () => {
    const { calls } = await fullReply({});
    const chat = calls.filter((c) => c.url.endsWith("/ai/v1/chat/completions"));
    expect(chat.every((c) => gatewayHeaders(c).includes("cf-aig-gateway-id"))).toBe(true);
  });

  it("does not offer web_search, and refuses it if the model asks anyway", async () => {
    const free = testConfig(FREE);
    const names = toolDefs(free).map((t) => t.function.name);
    expect(names).not.toContain("web_search");
    expect(names).toEqual(expect.arrayContaining(["web_fetch", "youtube_transcript", "generate_image", "create_poll"]));
    expect(toolDefs(testConfig()).map((t) => t.function.name)).toContain("web_search");

    const { f, calls } = fakeFetch(() => json({}, 500));
    const r = await runTool(
      free,
      "web_search",
      { query: "patch notes" },
      { state: newToolState(free), fetch: f, ...NO_LIMITS },
    );
    expect(r.content).toMatch(/Unknown tool web_search/);
    expect(calls).toEqual([]);
  });
});

describe("running out of the free allowance", () => {
  const msgs = [
    { role: "system" as const, content: "s" },
    { role: "user" as const, content: "hi" },
  ];
  const deps = (f: typeof fetch) => ({
    fetch: f,
    reserve: () => true,
    runTool: async () => ({ content: "", costUsd: 0 }),
  });

  // Marking the failure as "free allowance used up" is what tells the bot to stop rather than reach for credits.
  const cases: Array<[string, Record<string, string>, number, object, boolean]> = [
    [
      "a 429 with the allowance error code",
      FREE,
      429,
      { errors: [{ code: 3036, message: "daily free allocation" }] },
      true,
    ],
    ["the allowance error code on any status", FREE, 400, { errors: [{ code: 3036 }] }, true],
    ["another failure", FREE, 500, { errors: [{ code: 1000 }] }, false],
    ["a 429 in credits mode (the gateway's rate limit)", {}, 429, { errors: [] }, false],
  ];

  it("marks the model's failure as the free allowance being used up only when it is", async () => {
    for (const [label, env, status, body, exhausted] of cases) {
      const { f } = fakeFetch(() => json(body, status));
      const err = await answer(testConfig(env), msgs, deps(f)).catch((e) => e);
      expect(err, label).toBeInstanceOf(LlmError);
      expect(err.freeAllowance, label).toBe(exhausted);
    }
  });

  it("reports what it had reserved from the budget when the allowance runs out, so the reservation is settled, not leaked", async () => {
    const { f } = fakeFetch(() => json({ errors: [{ code: 3036 }] }, 429));
    const err = await answer(testConfig(FREE), msgs, deps(f)).catch((e) => e);
    expect(err.reservedUsd).toBeGreaterThan(0);
  });
});
