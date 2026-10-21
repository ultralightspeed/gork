import { describe, expect, it } from "vitest";
import {
  answer,
  cleanText,
  IMAGE_TOKENS,
  LlmError,
  type LlmResult,
  MAX_OUTPUT_TOKENS,
  REPLY_DEADLINE_SECONDS,
} from "../src/llm.ts";
import type { ReplyTally } from "../src/tools.ts";
import { fakeFetch, testConfig } from "./helpers.ts";

const cfg = testConfig();
const msgs = [
  { role: "system" as const, content: "s" },
  { role: "user" as const, content: "is the sky green?" },
];
const completion = (message: object, usage: object | null = { prompt_tokens: 100, completion_tokens: 20 }) =>
  new Response(JSON.stringify({ choices: [{ message }], ...(usage ? { usage } : {}) }));
const toolCall = (id: string, name: string, args: string) => ({
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});

/** A body of `mb` one-megabyte pieces of spaces; it ends, so a missing cap fails the test instead of hanging. */
function megabytes(mb: number) {
  const seen = { pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!(seen.pulls < mb)) return controller.close();
      seen.pulls++;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
    },
  });
  return { body, seen };
}

/** Answers each model call with the next response in the list. */
function scripted(responses: Response[]) {
  return fakeFetch(() => responses.shift()!);
}
const yes = () => true;

describe("answer", () => {
  it("refuses a model response larger than 8 MB", async () => {
    const { body, seen } = megabytes(30);
    const { f } = fakeFetch(() => new Response(body));
    const err = await answer(cfg, msgs, { fetch: f, runTool: async () => ({ content: "", costUsd: 0 }), reserve: yes })
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/larger than 8 MB/);
    expect(seen.pulls).toBeLessThan(12);
  });

  it("returns direct text, prices usage, and sends the gateway headers", async () => {
    const { f, calls } = scripted([completion({ content: "Nope, blue." })]);
    const r = await answer(cfg, msgs, { fetch: f, runTool: async () => ({ content: "", costUsd: 0 }), reserve: yes });
    expect(r.text).toBe("Nope, blue.");
    expect(r.toolCalls).toBe(0);
    expect(r.costUsd).toBeCloseTo((100 * cfg.llm.priceInPerM + 20 * cfg.llm.priceOutPerM) / 1e6, 10);
    expect(calls[0].headers["cf-aig-gateway-id"]).toBe(cfg.cf.gatewayId);
    expect(calls[0].headers["cf-aig-collect-log-payload"]).toBe("false");
  });

  it("runs a tool round then answers, adding tool cost", async () => {
    const { f, calls } = scripted([
      completion(toolCall("c1", "web_search", '{"query":"sky color"}')),
      completion({ content: "False. It's blue." }),
    ]);
    const seen: string[] = [];
    const r = await answer(cfg, msgs, {
      fetch: f,
      runTool: async (name) => {
        seen.push(name);
        return { content: "1. Sky\nhttps://e.x\nblue", costUsd: 0.00025 };
      },
      reserve: yes,
    });
    expect(seen).toEqual(["web_search"]);
    expect(r.text).toBe("False. It's blue.");
    expect(r.toolCalls).toBe(1);
    expect(calls[1].body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(r.costUsd).toBeCloseTo((200 * cfg.llm.priceInPerM + 40 * cfg.llm.priceOutPerM) / 1e6 + 0.00025, 10);
  });

  it("stops offering tools after MAX_TOOL_CALLS, counting every call", async () => {
    const c = testConfig({ MAX_TOOL_CALLS: "2" });
    const bad = toolCall("x", "web_search", "not json");
    const { f, calls } = scripted([completion(bad), completion(bad), completion({ content: "ok" })]);
    const r = await answer(c, msgs, {
      fetch: f,
      runTool: async () => ({ content: "Invalid", costUsd: 0 }),
      reserve: yes,
    });
    expect(r.text).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(calls[2].body.tools).toBeUndefined();
  });

  it("counts calls made in one round against MAX_TOOL_CALLS, and does not run the ones over it", async () => {
    const c = testConfig({ MAX_TOOL_CALLS: "1" });
    const two = {
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "web_search", arguments: '{"query":"a b"}' } },
        { id: "b", type: "function", function: { name: "web_search", arguments: '{"query":"c d"}' } },
      ],
    };
    const { f } = scripted([completion(two), completion({ content: "ok" })]);
    let ran = 0;
    await answer(c, msgs, {
      fetch: f,
      runTool: async () => {
        ran++;
        return { content: "r", costUsd: 0 };
      },
      reserve: yes,
    });
    expect(ran).toBe(1);
  });

  it("keeps offering tools while the reply deadline has not passed", async () => {
    const { f, calls } = scripted([
      completion(toolCall("c1", "web_search", '{"query":"x y"}')),
      completion({ content: "done" }),
    ]);
    let clock = 0;
    await answer(cfg, msgs, {
      fetch: f,
      now: () => clock,
      runTool: async () => {
        clock += (REPLY_DEADLINE_SECONDS - 1) * 1000;
        return { content: "r", costUsd: 0 };
      },
      reserve: yes,
    });
    expect(calls[1].body.tools).toBeDefined();
  });

  it("stops offering tools once the reply deadline has passed, and skips the calls still queued", async () => {
    const c = testConfig();
    const two = {
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "web_fetch", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "web_fetch", arguments: "{}" } },
      ],
    };
    const { f, calls } = scripted([completion(two), completion({ content: "what I have" })]);
    let clock = 1_000_000;
    const ran: string[] = [];
    const r = await answer(c, msgs, {
      fetch: f,
      now: () => clock,
      runTool: async (_name, _args) => {
        ran.push("fetch");
        clock += (REPLY_DEADLINE_SECONDS + 1) * 1000; // the first page read outlasts the whole deadline
        return { content: "page", costUsd: 0 };
      },
      reserve: yes,
    });
    expect(r.text).toBe("what I have");
    expect(ran).toEqual(["fetch"]);
    expect(calls[0].body.tools).toBeDefined();
    expect(calls[1].body.tools).toBeUndefined();
    expect(calls[1].body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "b" });
    expect(calls[1].body.messages.at(-1).content).toMatch(/time/i);
  });

  it("reserves before every round and stops cleanly when the budget refuses", async () => {
    const { f, calls } = scripted([
      completion(toolCall("c1", "web_search", '{"query":"x y"}')),
      completion({ content: "never sent" }),
    ]);
    const reservations: number[] = [];
    const r = await answer(cfg, msgs, {
      fetch: f,
      runTool: async () => ({ content: "r", costUsd: 0 }),
      reserve: (usd) => {
        reservations.push(usd);
        return reservations.length < 2;
      },
    });
    expect(r.outOfBudget).toBe(true);
    expect(calls).toHaveLength(1);
    expect(r.reservedUsd).toBeCloseTo(reservations[0], 10);
    expect(reservations[0]).toBeGreaterThan((MAX_OUTPUT_TOKENS * cfg.llm.priceOutPerM) / 1e6);
  });

  describe("images a tool returns", () => {
    const frame = (n: number) => ({ label: `Frame at ${n} s`, dataUrl: `data:image/jpeg;base64,F${n}`, frame: true });
    const two = {
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"a b"}' } },
        { id: "c2", type: "function", function: { name: "video_frames", arguments: "{}" } },
      ],
    };
    const roles = (m: { body: any }, from = 2) => m.body.messages.slice(from).map((x: any) => x.role);

    it("reach the model as one user message right after the round's tool messages, never between them", async () => {
      const { f, calls } = scripted([completion(two), completion({ content: "ok" })]);
      await answer(cfg, msgs, {
        fetch: f,
        runTool: async (name) =>
          name === "video_frames"
            ? { content: "Frames follow.", costUsd: 0, images: [frame(3), frame(4)] }
            : { content: "result", costUsd: 0, images: [frame(1)] },
        reserve: yes,
      });
      expect(roles(calls[1])).toEqual(["assistant", "tool", "tool", "user"]);
      const follow = calls[1].body.messages.at(-1);
      expect(follow.content.filter((p: any) => p.type === "image_url").map((p: any) => p.image_url.url)).toEqual([
        "data:image/jpeg;base64,F1",
        "data:image/jpeg;base64,F3",
        "data:image/jpeg;base64,F4",
      ]);
      expect(JSON.stringify(follow.content)).toContain("Frame at 3 s");
      expect(calls[1].body.messages.at(-2)).toMatchObject({
        role: "tool",
        tool_call_id: "c2",
        content: "Frames follow.",
      });
    });

    it("keep each round's images with that round, and stay in the conversation for later rounds", async () => {
      const one = (id: string) => ({
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "video_frames", arguments: "{}" } }],
      });
      const { f, calls } = scripted([completion(one("a")), completion(one("b")), completion({ content: "ok" })]);
      let n = 0;
      await answer(cfg, msgs, {
        fetch: f,
        runTool: async () => ({ content: "r", costUsd: 0, images: [frame(++n)] }),
        reserve: yes,
      });
      expect(roles(calls[2])).toEqual(["assistant", "tool", "user", "assistant", "tool", "user"]);
      expect(JSON.stringify(calls[2].body.messages)).toContain("F1");
      expect(JSON.stringify(calls[2].body.messages)).toContain("F2");
    });

    it("are counted in the reservation for the next model call (a 640px frame is about 600 tokens; IMAGE_TOKENS over-reserves)", async () => {
      const { f } = scripted([completion(two), completion({ content: "ok" })]);
      const seen: number[] = [];
      await answer(cfg, msgs, {
        fetch: f,
        runTool: async () => ({ content: "r", costUsd: 0, images: [frame(1), frame(2), frame(3)] }),
        reserve: (usd) => {
          seen.push(usd); // model rounds only: this test's tools reserve nothing
          return true;
        },
      });
      const perFrame = (IMAGE_TOKENS * cfg.llm.priceInPerM) / 1e6;
      // The second reservation also covers the assistant and tool messages, so it is at least the three frames more.
      expect(seen[1] - seen[0]).toBeGreaterThanOrEqual(3 * perFrame);
    });

    it("go to the model 8 at most, dropping the oldest frames before the asker's images", async () => {
      const own = (n: number) => ({ type: "image_url" as const, image_url: { url: `data:image/png;base64,A${n}` } });
      const label = (n: number) => ({ type: "text" as const, text: `Frame at ${n} s` });
      const img = (n: number) => ({
        type: "image_url" as const,
        image_url: { url: `data:image/jpeg;base64,F${n}` },
        frame: true as const,
      });
      const first = [
        { role: "system" as const, content: "s" },
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "q" },
            own(1),
            own(2),
            own(3),
            ...[0, 1, 2, 3, 4].flatMap((n) => [label(n), img(n)]),
          ],
        },
      ];
      const one = (id: string) => ({
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "video_frames", arguments: "{}" } }],
      });
      const { f, calls } = scripted([completion(one("a")), completion(one("b")), completion({ content: "ok" })]);
      let n = 10;
      await answer(cfg, first, {
        fetch: f,
        runTool: async () => ({ content: "r", costUsd: 0, images: [1, 2, 3, 4, 5].map(() => frame(++n)) }),
        reserve: yes,
      });
      const urls = (c: { body: any }) =>
        c.body.messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .filter((p: any) => p.type === "image_url")
          .map((p: any) => p.image_url.url.split(",")[1]);
      expect(calls.map((c) => urls(c).length)).toEqual([8, 8, 8]);
      expect(urls(calls[2])).toEqual(["A1", "A2", "A3", "F16", "F17", "F18", "F19", "F20"]);
      // A dropped frame keeps its label and says it is gone; the caller's messages are not changed.
      expect(JSON.stringify(calls[2].body.messages[1].content)).toContain(
        '"Frame at 0 s"},{"type":"text","text":"(no longer attached)"}',
      );
      expect(first[1].content).toHaveLength(14);
    });

    it("go to the model without the frame marker", async () => {
      const { f, calls } = scripted([completion(two), completion({ content: "ok" })]);
      await answer(cfg, msgs, {
        fetch: f,
        runTool: async () => ({ content: "r", costUsd: 0, images: [frame(1)] }),
        reserve: yes,
      });
      expect(JSON.stringify(calls[1].body.messages)).toContain("F1");
      expect(JSON.stringify(calls[1].body.messages)).not.toContain('"frame"');
    });

    it("offer video_frames to the model only when the request has a video", async () => {
      const names = (m: { body: any }) => (m.body.tools ?? []).map((t: any) => t.function.name);
      const a = scripted([completion({ content: "ok" })]);
      await answer(cfg, msgs, { fetch: a.f, runTool: async () => ({ content: "", costUsd: 0 }), reserve: yes });
      expect(names(a.calls[0])).not.toContain("video_frames");
      const b = scripted([completion({ content: "ok" })]);
      await answer(cfg, msgs, {
        fetch: b.f,
        runTool: async () => ({ content: "", costUsd: 0 }),
        reserve: yes,
        videoTool: true,
      });
      expect(names(b.calls[0])).toContain("video_frames");
    });
  });

  // Each reply may carry one generated image, one poll and one event: the first one a tool makes is kept, and the
  // next tool call is told it already exists so it can refuse.
  it.each([
    {
      what: "image attachment",
      tool: "generate_image",
      made: { attachment: { name: "gork-1.jpg", data: Buffer.from([1, 2]) } },
      count: (t: ReplyTally) => t.images,
      collected: (r: LlmResult) => r.attachments[0],
      expected: { name: "gork-1.jpg", data: Buffer.from([1, 2]) },
    },
    {
      what: "poll",
      tool: "create_poll",
      made: { poll: { question: "q?", answers: ["a", "b"], durationHours: 24, multiselect: false } },
      count: (t: ReplyTally) => t.polls,
      collected: (r: LlmResult) => r.poll,
      expected: { question: "q?", answers: ["a", "b"], durationHours: 24, multiselect: false },
    },
    {
      what: "event",
      tool: "create_event",
      made: {
        event: {
          name: "Raid",
          start: new Date("2026-10-23T20:00:00Z"),
          end: null,
          where: { kind: "location" as const, text: "Discord" },
          description: null,
        },
      },
      count: (t: ReplyTally) => t.events,
      collected: (r: LlmResult) => r.event,
      expected: {
        name: "Raid",
        start: new Date("2026-10-23T20:00:00Z"),
        end: null,
        where: { kind: "location", text: "Discord" },
        description: null,
      },
    },
  ])(
    "collects the $what a tool made and tells the next call one exists",
    async ({ tool, made, count, collected, expected }) => {
      const { f } = scripted([
        completion(toolCall("c1", tool, "{}")),
        completion(toolCall("c2", tool, "{}")),
        completion({ content: "done" }),
      ]);
      const seen: number[] = [];
      const r = await answer(cfg, msgs, {
        fetch: f,
        runTool: async (_n, _a, tally) => {
          seen.push(count(tally));
          return seen.length === 1 ? { content: "made", costUsd: 0, ...made } : { content: "only one", costUsd: 0 };
        },
        reserve: yes,
      });
      expect(seen).toEqual([0, 1]);
      expect(collected(r)).toEqual(expected);
    },
  );

  it("reports whether a tool asked for an @everyone ping", async () => {
    const { f } = scripted([
      completion(toolCall("c1", "ping_everyone", "{}")),
      completion({ content: "@everyone hi" }),
    ]);
    const r = await answer(cfg, msgs, {
      fetch: f,
      runTool: async () => ({ content: "ok", costUsd: 0, pingEveryone: true }),
      reserve: yes,
    });
    expect(r.pingEveryone).toBe(true);
    const plain = scripted([completion({ content: "hi" })]);
    const r2 = await answer(cfg, msgs, {
      fetch: plain.f,
      runTool: async () => ({ content: "", costUsd: 0 }),
      reserve: yes,
    });
    expect(r2.pingEveryone).toBe(false);
  });

  it("treats usage that is not a number as missing, so the cost stays a number", async () => {
    for (const usage of [
      { prompt_tokens: "100", completion_tokens: 20 },
      { prompt_tokens: {}, completion_tokens: null },
    ]) {
      const { f } = scripted([completion({ content: "hi" }, usage)]);
      const r = await answer(cfg, msgs, { fetch: f, runTool: async () => ({ content: "", costUsd: 0 }), reserve: yes });
      expect(r.usageEstimated).toBe(true);
      expect(typeof r.promptTokens).toBe("number");
      expect(Number.isFinite(r.costUsd)).toBe(true);
    }
  });

  it("names the field and the model when tool_calls is not a list", async () => {
    const { f } = scripted([completion({ content: null, tool_calls: { id: "x" } })]);
    const err = await answer(cfg, msgs, {
      fetch: f,
      runTool: async () => ({ content: "", costUsd: 0 }),
      reserve: yes,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain("tool_calls");
    expect(String(err.message)).toContain(cfg.llm.model);
  });

  it("charges max output tokens when usage is missing", async () => {
    const { f } = scripted([completion({ content: "hi" }, null)]);
    const r = await answer(cfg, msgs, { fetch: f, runTool: async () => ({ content: "", costUsd: 0 }), reserve: yes });
    expect(r.usageEstimated).toBe(true);
    expect(r.completionTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("throws on HTTP errors, reporting what was reserved so the caller can settle the ledger", async () => {
    const { f } = fakeFetch(() => new Response("nope", { status: 500 }));
    const err = await answer(cfg, msgs, {
      fetch: f,
      runTool: async () => ({ content: "", costUsd: 0 }),
      reserve: yes,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/500/);
    expect(err.reservedUsd).toBeGreaterThan(0);
  });
});

describe("answer: what a tool may reserve, and what it is told", () => {
  const searches = (...ids: string[]) => ({
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: "function",
      function: { name: "web_search", arguments: '{"query":"x y"}' },
    })),
  });

  it("counts what a tool reserves in reservedUsd, so the reply settles the hold even when the tool spends nothing", async () => {
    const { f } = scripted([completion(searches("a")), completion({ content: "ok" })]);
    const budget: number[] = [];
    const r = await answer(cfg, msgs, {
      fetch: f,
      runTool: async (_name, _args, _tally, turn) => {
        expect(turn.reserve(0.005)).toBe(true);
        return { content: "web_search failed.", costUsd: 0 };
      },
      reserve: (usd) => {
        budget.push(usd);
        return true;
      },
    });
    expect(budget).toContain(0.005);
    expect(r.reservedUsd).toBeCloseTo(
      budget.reduce((a, b) => a + b, 0),
      10,
    );
  });

  it("doesn't count a reservation the budget refused", async () => {
    const { f } = scripted([completion(searches("a")), completion({ content: "ok" })]);
    let modelRounds = 0;
    const r = await answer(cfg, msgs, {
      fetch: f,
      runTool: async (_name, _args, _tally, turn) => {
        expect(turn.reserve(0.005)).toBe(false);
        return { content: "The daily budget is used up, so that search wasn't run.", costUsd: 0 };
      },
      reserve: (usd) => {
        if (usd === 0.005) return false;
        modelRounds += usd;
        return true;
      },
    });
    expect(r.reservedUsd).toBeCloseTo(modelRounds, 10);
  });

  it("tells each search how many the reply already ran and how many used the fallback, and totals them", async () => {
    const { f } = scripted([completion(searches("a", "b")), completion(searches("c")), completion({ content: "ok" })]);
    const seen: Array<[number, number]> = [];
    const r = await answer(cfg, msgs, {
      fetch: f,
      runTool: async (_name, _args, tally) => {
        seen.push([tally.searchesRun, tally.fallbackSearches]);
        const first = tally.searchesRun === 0;
        return { content: "hits", costUsd: 0, search: { primary: first ? 1 : 0, fallback: first ? 0 : 1 } };
      },
      reserve: yes,
    });
    expect(seen).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
    ]);
    expect(r.searches).toEqual({ primary: 1, fallback: 2 });
  });

  it("gives a tool the reply's deadline", async () => {
    const { f } = scripted([completion(searches("a")), completion({ content: "ok" })]);
    const start = 5_000_000;
    let deadline = 0;
    await answer(cfg, msgs, {
      fetch: f,
      now: () => start,
      runTool: async (_name, _args, _tally, turn) => {
        deadline = turn.deadline;
        return { content: "hits", costUsd: 0 };
      },
      reserve: yes,
    });
    expect(deadline).toBe(start + REPLY_DEADLINE_SECONDS * 1000);
  });
});

describe("cleanText", () => {
  it("strips think blocks and never returns empty", () => {
    expect(cleanText("<think>hmm</think>  Yes.")).toBe("Yes.");
    expect(cleanText(null)).toBe("");
    expect(cleanText("<think>unterminated")).toBe("");
    expect(cleanText("Let me think...</think>\n\nBlue.")).toBe("Blue.");
  });
});
