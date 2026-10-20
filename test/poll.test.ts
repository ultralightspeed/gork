import { describe, expect, it } from "vitest";
import { parsePoll } from "../src/poll.ts";

describe("parsePoll", () => {
  it("accepts a question with 2-10 answers, defaults to 24h single-choice, and keeps a valid duration and multiselect", () => {
    expect(parsePoll({ question: " best raid? ", answers: ["MC", " BWL "] })).toEqual({
      question: "best raid?",
      answers: ["MC", "BWL"],
      durationHours: 24,
      multiselect: false,
    });
    const p = parsePoll({ question: "q?", answers: ["a", "b"], duration_hours: 72, allow_multiselect: true });
    expect(p).toMatchObject({ durationHours: 72, multiselect: true });
  });

  it("rejects what Discord would reject, with a reason the model can fix", () => {
    const bad = [
      {},
      { question: "q?", answers: ["only one"] },
      { question: "q?", answers: Array.from({ length: 11 }, (_, i) => `opt ${i}`) },
      { question: "q?", answers: ["a", "x".repeat(56)] },
      { question: "x".repeat(301), answers: ["a", "b"] },
      { question: "q?", answers: ["same", "Same"] },
      { question: "q?", answers: ["a", ""] },
      { question: "q?", answers: ["a", "\u200b"] },
      { question: "q?", answers: ["a\u200b", "a"] },
      { question: "\u200b\u202e", answers: ["a", "b"] },
      { question: "q?", answers: ["a", "b"], duration_hours: 0 },
      { question: "q?", answers: ["a", "b"], duration_hours: 769 },
      { question: "q?", answers: ["a", "b"], duration_hours: 1.5 },
    ];
    for (const args of bad) expect(typeof parsePoll(args), JSON.stringify(args).slice(0, 80)).toBe("string");
  });
});
