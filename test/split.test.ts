import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/split.ts";

describe("splitMessage", () => {
  it("never exceeds 2000 chars and prefers newlines; short text stays whole", () => {
    expect(splitMessage("hi")).toEqual(["hi"]);
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const out = splitMessage(text);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(2000);
    expect(out[0].endsWith("x")).toBe(true);
  });

  it("closes and reopens code fences across chunks", () => {
    const text = `\`\`\`ts\n${"const a = 1;\n".repeat(250)}\`\`\``;
    const out = splitMessage(text);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    expect(out[1].startsWith("```ts")).toBe(true);
  });

  it("caps chunk count and marks trimming", () => {
    const out = splitMessage("y ".repeat(10000), 1900, 2);
    expect(out).toHaveLength(2);
    expect(out[1].endsWith("…(trimmed)")).toBe(true);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(2000);
  });
});
