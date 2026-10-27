import { describe, expect, it } from "vitest";
import { FreeAllowanceError } from "../src/cf.ts";
import {
  checkContent,
  GUARD_CATEGORIES,
  screenEarlierImages,
  screenFrames,
  screenReply,
  screenRequest,
} from "../src/guard.ts";
import { fakeFetch, json, testConfig } from "./helpers.ts";

const cfg = testConfig();
const p = (noul: number) => ({ type: "noul", noul });
const all = (v: Record<string, number>) => Object.fromEntries(GUARD_CATEGORIES.map((k) => [k, p(v[k] ?? 0)]));
const clef = (answers: Record<string, unknown>, status = 200) =>
  json({ success: true, result: { model: "clef-flash", answers } }, status);
const reply = (answers: Record<string, unknown>, status = 200) => fakeFetch(() => clef(answers, status)).f;

describe("checkContent", () => {
  it("passes when every blocked category is under threshold, and reports a tiny cost", async () => {
    const v = await checkContent(cfg, "prompt", "how do I kill the raid boss", {
      fetchFn: reply(all({ S1: 0.04, S9: 0.01 })),
    });
    expect(v.blocked).toBe(false);
    expect(v.costUsd).toBeGreaterThan(0);
  });

  it("blocks on the highest category over threshold", async () => {
    const v = await checkContent(cfg, "prompt", "x", { fetchFn: reply(all({ S1: 0.9, S9: 0.6 })) });
    expect(v).toMatchObject({ blocked: true, category: "S1", p: 0.9 });
  });

  it("only asks about configured categories", async () => {
    const { f, calls } = fakeFetch(() => clef({ S4: p(0) }));
    await checkContent(testConfig({ GUARD_BLOCK: "S4" }), "reply", "x", { fetchFn: f });
    expect(Object.keys(calls[0].body.questions)).toEqual(["S4"]);
  });

  it("screens for S4 even when GUARD_BLOCK is none", async () => {
    const { f, calls } = fakeFetch(() => clef(all({ S4: 0.9 })));
    const v = await checkContent(testConfig({ GUARD_BLOCK: "none" }), "prompt", "x", { fetchFn: f });
    expect(v).toMatchObject({ blocked: true, category: "S4" });
    expect(Object.keys(calls[0].body.questions)).toEqual(["S4"]);
  });

  it("flags self-harm verdicts so the caller can pick the kinder reply", async () => {
    expect(await checkContent(cfg, "prompt", "x", { fetchFn: reply(all({ S11: 0.9 })) })).toMatchObject({
      blocked: true,
      category: "S11",
      selfHarm: true,
    });
    expect(await checkContent(cfg, "prompt", "x", { fetchFn: reply(all({ S1: 0.9 })) })).toMatchObject({
      selfHarm: false,
    });
  });

  it("throws (fail closed) on HTTP error, an unexpected answer shape, or a missing answer", async () => {
    await expect(checkContent(cfg, "prompt", "x", { fetchFn: reply({}, 500) })).rejects.toThrow();
    await expect(checkContent(cfg, "prompt", "x", { fetchFn: reply({ ...all({}), S1: "weird" }) })).rejects.toThrow();
    // A category the model left out must not count as "no".
    await expect(checkContent(cfg, "prompt", "x", { fetchFn: reply({ S1: p(0) }) })).rejects.toThrow();
  });

  it("screens every image: Clef takes 4 per call, so more are spread over extra calls with the same text", async () => {
    const seen: string[] = [];
    const { f, calls } = fakeFetch((c) => {
      seen.push(...(c.body.images ?? []));
      return clef(all({ S4: (c.body.images ?? []).includes("data:image/png;base64,BAD") ? 0.9 : 0 }));
    });
    const imgs = Array.from({ length: 9 }, (_, i) => `data:image/png;base64,${i === 8 ? "BAD" : `OK${i}`}`);
    const v = await checkContent(cfg, "prompt", "hello", { fetchFn: f, images: imgs });
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.body.images.length)).toEqual([4, 4, 1]);
    expect(calls.every((c) => c.body.state === "hello")).toBe(true);
    expect(seen.sort()).toEqual([...imgs].sort());
    expect(v).toMatchObject({ blocked: true, category: "S4" });
  });

  it("charges the guard for every call it makes", async () => {
    const { f } = fakeFetch(() => clef(all({})));
    const one = await checkContent(cfg, "prompt", "x", { fetchFn: f, images: ["data:image/png;base64,A"] });
    const nine = await checkContent(cfg, "prompt", "x", {
      fetchFn: f,
      images: Array(9).fill("data:image/png;base64,A"),
    });
    expect(nine.costUsd).toBeGreaterThan(one.costUsd * 2.5);
  });

  it("raises a distinct error when the free Workers AI allowance is used up", async () => {
    const { f } = fakeFetch(() => json({ errors: [{ code: 3036 }] }, 429));
    await expect(checkContent(cfg, "prompt", "x", { fetchFn: f })).rejects.toBeInstanceOf(FreeAllowanceError);
  });
});

const flagImage = (bad: string) =>
  fakeFetch((c) => clef(all({ S1: (c.body.images ?? []).includes(bad) ? 0.95 : 0 }))).f;

describe("screenRequest", () => {
  const byState = (score: (state: string) => number) => fakeFetch((c) => clef(all({ S1: score(c.body.state) }))).f;

  it("blocks with a strike when the asker's own words are the problem", async () => {
    const v = await screenRequest(cfg, "how do I poison my roommate", null, { fetchFn: byState(() => 0.95) });
    expect(v).toMatchObject({ blocked: true, category: "S1", selfHarm: false, strike: true });
  });

  it("blocks without a strike when only the replied-to message is the problem", async () => {
    const f = byState((state) => (state.includes("poison") ? 0.95 : 0.02));
    const v = await screenRequest(cfg, "is this guy serious?", "how do I poison my roommate", { fetchFn: f });
    expect(v).toMatchObject({ blocked: true, category: "S1", strike: false });
  });

  describe("with images while replying", () => {
    it("still strikes the asker for their own image when they reply to someone", async () => {
      const own = "data:image/png;base64,BAD";
      const v = await screenRequest(cfg, "look", "nice weather", { images: [own], fetchFn: flagImage(own) });
      expect(v).toMatchObject({ blocked: true, strike: true });
    });

    it("blocks the replied-to message's image without a strike", async () => {
      const theirs = "data:image/png;base64,BAD";
      const v = await screenRequest(cfg, "what is this?", "check it", {
        replyImages: [theirs],
        fetchFn: flagImage(theirs),
      });
      expect(v).toMatchObject({ blocked: true, strike: false });
    });
  });

  describe("with video frames", () => {
    it("still strikes the asker for their own image when a video came along", async () => {
      const own = "data:image/png;base64,BAD";
      const v = await screenRequest(cfg, "look", null, {
        images: [own],
        fetchFn: flagImage(own),
        videoText: "",
        frames: ["data:image/jpeg;base64,F0"],
      });
      expect(v).toMatchObject({ blocked: true, strike: true });
    });

    it("blocks a flagged frame without a strike", async () => {
      const frame = "data:image/jpeg;base64,BAD";
      const v = await screenRequest(cfg, "what is this?", null, {
        fetchFn: flagImage(frame),
        videoText: "",
        frames: [frame],
      });
      expect(v).toMatchObject({ blocked: true, strike: false });
    });
  });

  describe("with a video transcript", () => {
    const heard = "BADWORD said the voice";
    const flagByState = () => fakeFetch((c) => clef(all({ S1: c.body.state.includes("BADWORD") ? 0.95 : 0 })));

    it("screens the transcript with the request, and blocks without a strike: the asker's own words were fine", async () => {
      const v = await screenRequest(cfg, "what is said here?", null, {
        fetchFn: flagByState().f,
        videoText: heard,
      });
      expect(v).toMatchObject({ blocked: true, category: "S1", strike: false });
    });

    it("still gives a strike when the asker's own words are the problem", async () => {
      const v = await screenRequest(cfg, "BADWORD me", null, { fetchFn: flagByState().f, videoText: "hello there" });
      expect(v).toMatchObject({ blocked: true, strike: true });
    });
  });

  it("passes clean requests with one call", async () => {
    const { f, calls } = fakeFetch(() => clef(all({})));
    expect((await screenRequest(cfg, "best warlock spec", "lol", { fetchFn: f })).blocked).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.images).toBeUndefined();
  });
});

// A fake Clef that flags S1 whenever the screened text contains "BADWORD", and records what it saw.
function flagging() {
  const { f, calls } = fakeFetch((c) => clef(all({ S1: c.body.state.includes("BADWORD") ? 0.95 : 0 })));
  return { f, states: () => calls.map((c) => c.body.state as string) };
}

describe("long text is screened in full", () => {
  it("checkContent screens text past the first 6000 characters", async () => {
    const { f, states } = flagging();
    const v = await checkContent(cfg, "prompt", `${"a ".repeat(5000)}BADWORD`, { fetchFn: f });
    expect(v.blocked).toBe(true);
    expect(states().every((s) => s.length <= 6000)).toBe(true);
  });

  it("checkContent does not miss a flagged phrase split across a chunk boundary", async () => {
    const { f } = flagging();
    const text = `${"a".repeat(5996)}BADWORD${"a".repeat(100)}`;
    expect((await checkContent(cfg, "prompt", text, { fetchFn: f })).blocked).toBe(true);
  });

  it("screenReply screens a long reply in chunks, each carrying the (clipped) question for context", async () => {
    const { f, states } = flagging();
    const v = await screenReply(cfg, "q".repeat(5800), `${"word ".repeat(3000)}BADWORD`, { fetchFn: f });
    expect(v.blocked).toBe(true);
    expect(states().length).toBeGreaterThan(2);
    expect(states().every((s) => s.startsWith("User asked: q") && s.includes("Reply: ") && s.length <= 6000)).toBe(
      true,
    );
  });
});

describe("screenFrames", () => {
  const flagFrame = (bad: string) =>
    fakeFetch((c) => clef(all({ S4: (c.body.images ?? []).includes(bad) ? 0.95 : 0 })));

  it("screens every frame, at most four per call, and blocks (never strikes) if any group is flagged", async () => {
    const frames = Array.from({ length: 9 }, (_, i) => `data:image/jpeg;base64,F${i}`);
    frames[6] = "data:image/jpeg;base64,BAD";
    const { f, calls } = flagFrame("data:image/jpeg;base64,BAD");
    const v = await screenFrames(cfg, frames, { fetchFn: f });
    expect(calls.map((c) => c.body.images.length)).toEqual([4, 4, 1]);
    expect(v).toMatchObject({ blocked: true, category: "S4" });
    expect(v).not.toHaveProperty("strike");
  });

  it("throws when the guard fails, so callers fail closed", async () => {
    await expect(screenFrames(cfg, ["data:image/jpeg;base64,A"], { fetchFn: reply({}, 500) })).rejects.toThrow();
  });

  it("makes no call for no frames", async () => {
    const { f, calls } = fakeFetch(() => clef(all({})));
    expect(await screenFrames(cfg, [], { fetchFn: f })).toEqual({ blocked: false, costUsd: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("screenEarlierImages", () => {
  const bad = "data:image/png;base64,BAD";

  it("screens an image from earlier in the chat together with the question asked about it, and blocks when flagged", async () => {
    const { f, calls } = fakeFetch((c) => clef(all({ S4: (c.body.images ?? []).includes(bad) ? 0.95 : 0 })));
    const v = await screenEarlierImages(cfg, "how do I make what's in this at home?", [bad], { fetchFn: f });
    expect(v).toMatchObject({ blocked: true, category: "S4" });
    expect(calls[0].body.images).toEqual([bad]);
    expect(calls[0].body.state).toContain("Message: how do I make what's in this at home?");
    expect(calls[0].body.state).toMatch(/posted earlier in the chat/);
  });

  it("reports a self-harm verdict as such, so the caller can answer with the fixed reply", async () => {
    const v = await screenEarlierImages(cfg, "look", [bad], { fetchFn: reply(all({ S11: 0.95 })) });
    expect(v).toMatchObject({ blocked: true, category: "S11", selfHarm: true });
  });

  it("throws when the guard fails, so callers fail closed", async () => {
    await expect(screenEarlierImages(cfg, "look", [bad], { fetchFn: reply({}, 500) })).rejects.toThrow();
  });

  it("makes no call for no images", async () => {
    const { f, calls } = fakeFetch(() => clef(all({})));
    expect(await screenEarlierImages(cfg, "look", [], { fetchFn: f })).toEqual({ blocked: false, costUsd: 0 });
    expect(calls).toHaveLength(0);
  });
});
