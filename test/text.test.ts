import { describe, expect, it } from "vitest";
import { printable } from "../scripts/lib/text.ts";

describe("printable", () => {
  it("keeps ordinary text, including accents and emoji", () => {
    expect(printable("Café 🎮 server")).toBe("Café 🎮 server");
  });

  it("removes C0 and C1 controls, DEL and the escape byte, which a terminal would act on", () => {
    expect(printable("a\x00b\x07c\x1b[31md\x7fe\nf")).toBe("abc[31mdef");
    expect(printable("a\u0080b\u009bc\u009fd")).toBe("abcd");
  });

  it("removes the invisible and bidi characters the bot strips from chat text, so a name can't reorder what follows", () => {
    // bidi marks and overrides, zero-width space and joiner, word joiner, BOM, a tag character, a Hangul filler
    for (const cp of [
      0x200e, 0x202a, 0x202e, 0x2066, 0x2069, 0x061c, 0x200b, 0x200d, 0x2060, 0xfeff, 0xe0041, 0x3164,
    ]) {
      expect(printable(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe("ab");
    }
  });

  it("caps the length after cleaning", () => {
    expect(printable("x".repeat(100), 10)).toBe("x".repeat(10));
    const override = String.fromCodePoint(0x202e); // a right-to-left override: invisible, so it goes before the cap
    expect(printable(`${override.repeat(100)}abc`, 10)).toBe("abc");
  });
});
