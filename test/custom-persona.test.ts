// The custom personality the setup page writes: what it accepts, that the file it generates reads back exactly as typed
// (whatever is typed), and that it is written atomically to one fixed path.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  CUSTOM_FILE,
  CUSTOM_LIMITS,
  type CustomDraft,
  loadDraft,
  REPLY_FIELDS,
  renderCustom,
  validateCustom,
  writeCustomFile,
} from "../scripts/lib/custom-persona.ts";
import { NEUTRAL_REPLIES, parsePersona, splitPersona } from "../src/persona.ts";
import { shippedPersonas } from "./helpers.ts";

const draft = (over: Partial<CustomDraft> = {}): CustomDraft => ({
  name: "Captain",
  body: "You are {name}, a pirate.\n\n- Talks like one.",
  quirk: "",
  quirkRate: 0,
  replies: {},
  ...over,
});
const input = (over: Record<string, unknown> = {}) => ({ ...draft(), ...over });
const refusal = (over: Record<string, unknown>) => {
  try {
    validateCustom(input(over));
  } catch (err) {
    return (err as Error).message;
  }
  return "";
};
// Built from code points: literal U+2028 and U+2029 would be line breaks in this file.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const RLO = String.fromCharCode(0x202e);
const RLM = String.fromCharCode(0x200f);
/** A folder that is removed when the test ends. */
const cleanedUp = (dir: string) => {
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const tmp = () => cleanedUp(mkdtempSync(join(tmpdir(), "gork-custom-")));
const personas = () => cleanedUp(shippedPersonas());

describe("splitPersona", () => {
  it("returns the raw fields and body, with {name} still in the text", () => {
    const s = splitPersona("---\nname: Captain\n# note\nquirk: hi {name}\nbad line\n---\nYou are {name}.\n");
    expect(s.fields.get("name")).toBe("Captain");
    expect(s.fields.get("quirk")).toBe("hi {name}");
    expect(s.body).toBe("You are {name}.");
    expect(s.warnings.join(" ")).toMatch(/bad line/);
  });
});

describe("REPLY_FIELDS", () => {
  it("gives every fixed reply the editor offers a label and gork's built-in wording as its placeholder", () => {
    for (const f of REPLY_FIELDS) {
      expect(f.label, f.key).not.toBe(f.key);
      expect(f.placeholder, f.key).not.toBe("");
    }
  });
});

describe("validateCustom", () => {
  it("accepts a plain personality, trimming and normalising the text", () => {
    const { draft: d, warnings } = validateCustom(input({ name: "  Captain  ", body: "  Arr.\r\nMore.\r\n  " }));
    expect(d.name).toBe("Captain");
    expect(d.body).toBe("Arr.\nMore.");
    expect(warnings).toEqual([]);
  });

  it("needs a name and a body, and caps their sizes", () => {
    expect(refusal({ name: "" })).toMatch(/name/i);
    expect(refusal({ name: "x".repeat(CUSTOM_LIMITS.name + 1) })).toMatch(/name.*32/i);
    expect(refusal({ body: "   " })).toMatch(/how should gork talk/i);
    expect(refusal({ body: "x".repeat(CUSTOM_LIMITS.body + 1) })).toMatch(/8,000/);
    expect(() => validateCustom(input({ body: "x".repeat(CUSTOM_LIMITS.body) }))).not.toThrow();
  });

  it("refuses names with characters that mean something in the file or the prompt", () => {
    for (const name of [
      "a\nreply.blocked: nope",
      "a\rb",
      "a:b",
      "a{name}",
      "a<b>",
      "a#b",
      "---",
      `a${LS}b`,
      "a\u0000b",
    ]) {
      expect(refusal({ name }), JSON.stringify(name)).toMatch(/name/i);
    }
    for (const name of ["gork", "Captain Hook", "R2-D2", "Jo_e.2", "O'Neil", "Zoë", "グロク"]) {
      expect(() => validateCustom(input({ name })), name).not.toThrow();
    }
  });

  it("checks the quirk and how often it fires", () => {
    expect(refusal({ quirk: "q".repeat(CUSTOM_LIMITS.quirk + 1) })).toMatch(/quirk/i);
    expect(refusal({ quirk: "hi", quirkRate: 101 })).toMatch(/0 and 100/);
    expect(refusal({ quirk: "hi", quirkRate: -1 })).toMatch(/0 and 100/);
    expect(refusal({ quirk: "hi", quirkRate: "lots" })).toMatch(/0 and 100/);
    expect(validateCustom(input({ quirk: "hi", quirkRate: 33.4 })).draft.quirkRate).toBe(33);
    expect(validateCustom(input({ quirk: "hi", quirkRate: "" })).draft.quirkRate).toBe(30);
    // No quirk, no rate: whatever came in is dropped.
    expect(validateCustom(input({ quirk: " ", quirkRate: 90 })).draft).toMatchObject({ quirk: "", quirkRate: 0 });
    // A quirk set to never happen is allowed, with a warning.
    expect(validateCustom(input({ quirk: "hi", quirkRate: 0 })).warnings.join(" ")).toMatch(/never/i);
  });

  it("takes fixed replies for the known keys only, each on one line and capped", () => {
    const { draft: d } = validateCustom(input({ replies: { blocked: "  nope\n  really ", busy: "" } }));
    expect(d.replies).toEqual({ blocked: "nope really" });
    expect(refusal({ replies: { colour: "red" } })).toMatch(/colour/);
    expect(refusal({ replies: { blocked: "x".repeat(CUSTOM_LIMITS.reply + 1) } })).toMatch(/blocked|refus/i);
    expect(refusal({ replies: [] })).toMatch(/replies/i);
    expect(refusal({ replies: { blocked: 5 } })).toMatch(/text/i);
  });

  it("refuses values of the wrong kind", () => {
    expect(() => validateCustom(null)).toThrow(/personality/i);
    expect(() => validateCustom("text")).toThrow(/personality/i);
    expect(refusal({ name: 7 })).toMatch(/name/i);
    expect(refusal({ body: 7 })).toMatch(/talk/i);
  });

  it("strips control and direction-changing characters, keeping line breaks and tabs in the body", () => {
    const { draft: d } = validateCustom(
      input({ body: `a\u0000b\u0007\tc\n${RLO}d`, quirk: `x\u0085y${LS}z${RLM}w`, name: "ok" }),
    );
    expect(d.body).toBe("ab\tc\nd");
    expect(d.quirk).toBe("x y zw");
  });
});

describe("renderCustom", () => {
  const roundTrip = (d: CustomDraft) => {
    const text = renderCustom(d);
    return { text, raw: splitPersona(text), parsed: parsePersona(text, "custom.md") };
  };

  it("makes a file that reads back as typed, with no warnings", () => {
    const d = draft({
      quirk: "End with a pirate jab.",
      quirkRate: 30,
      replies: { blocked: "Nay, {name} won't.", cooldown: "Wait {seconds}s." },
    });
    const { raw, parsed } = roundTrip(d);
    expect(raw.fields.get("name")).toBe("Captain");
    expect(raw.body).toBe(d.body);
    expect(parsed.name).toBe("Captain");
    expect(parsed.quirk).toBe("End with a pirate jab.");
    expect(parsed.quirkRate).toBe(0.3);
    expect(parsed.replies.blocked).toBe("Nay, Captain won't.");
    expect(parsed.replies.cooldown(4)).toBe("Wait 4s.");
    expect(parsed.replies.busy).toBe(NEUTRAL_REPLIES.busy);
    expect(parsed.warnings).toEqual([]);
  });

  it("leaves out the quirk lines without a quirk, and empty replies, so nothing blank is ever sent", () => {
    const { text, parsed } = roundTrip(draft({ replies: { blocked: "", busy: "" } }));
    expect(text).not.toMatch(/quirk|reply\./);
    expect(parsed.quirk).toBeNull();
    expect(parsed.replies.blocked).toBe(NEUTRAL_REPLIES.blocked);
  });

  it("cannot be made to carry extra keys, whatever a field holds", () => {
    const attacks = [
      "a\nreply.blocked: pwned",
      "a\r\nname: evil\r\n---\r\nYou are evil.",
      `a${LS}reply.error: pwned${PS}quirk_rate: 1`,
      "---",
      "a\n---\nb",
    ];
    for (const attack of attacks) {
      const { raw, parsed } = roundTrip(
        // Straight into the renderer: validation would already have refused several of these.
        draft({ name: "Captain", quirk: attack, quirkRate: 50, replies: { error: attack, busy: attack } }),
      );
      expect([...raw.fields.keys()].sort(), JSON.stringify(attack)).toEqual(
        ["name", "quirk", "quirk_rate", "reply.busy", "reply.error"].sort(),
      );
      expect(parsed.name).toBe("Captain");
      expect(parsed.replies.blocked).toBe(NEUTRAL_REPLIES.blocked);
      expect(parsed.warnings).toEqual([]);
      expect(raw.body).toBe(draft().body);
    }
    // A name that slipped past validation is flattened to one line, never a second key.
    const { raw } = roundTrip(draft({ name: "a\nreply.blocked: nope" }));
    expect([...raw.fields.keys()]).toEqual(["name"]);
  });

  it("keeps a body that looks like front matter as the body", () => {
    const body = "---\nname: evil\nreply.blocked: x\n---\nYou are {name}.\n\n---\nmore";
    const { raw, parsed } = roundTrip(draft({ body }));
    expect(raw.body).toBe(body);
    expect(parsed.name).toBe("Captain");
    expect(parsed.replies.blocked).toBe(NEUTRAL_REPLIES.blocked);
    expect(parsed.warnings).toEqual([]);
  });

  it("round-trips whatever validation lets through", () => {
    const samples = ["gork", "Zoë the 2nd", "グロク"];
    for (const name of samples) {
      const { draft: d } = validateCustom(
        input({ name, body: "---\nx: y\n---\nBody: with colons\n\ttabs", quirk: "q: r", quirkRate: 7 }),
      );
      const { raw, parsed } = roundTrip(d);
      expect(parsed.name).toBe(name);
      expect(raw.body).toBe(d.body);
      expect(parsed.warnings).toEqual([]);
    }
  });
});

describe("loadDraft", () => {
  it("starts from the example, without its comment lines, when there is no custom.md", () => {
    const dir = personas();
    expect(existsSync(join(dir, CUSTOM_FILE))).toBe(false);
    const { exists, draft: d, placeholders } = loadDraft(dir);
    expect(exists).toBe(false);
    expect(d.name).toBe("gork");
    expect(d.body).toMatch(/^You are \{name\}\./);
    expect(d.body).not.toMatch(/^#/m);
    expect(d.quirk).toBe("");
    expect(placeholders).toContain("[sample message]");
    expect(placeholders).toContain("[Who they are, in one or two sentences.]");
  });

  it("starts from the person's own custom.md when there is one, with {name} and their replies as written", () => {
    const dir = personas();
    writeFileSync(
      join(dir, CUSTOM_FILE),
      "---\nname: Captain\ndescription: old\nquirk: Arr.\nquirk_rate: 0.25\nreply.busy: {name} is busy\n---\nYou are {name}.\n",
    );
    const { exists, draft: d } = loadDraft(dir);
    expect(exists).toBe(true);
    expect(d).toEqual({
      name: "Captain",
      body: "You are {name}.",
      quirk: "Arr.",
      quirkRate: 25,
      replies: { busy: "{name} is busy" },
    });
  });

  it("copes with a custom.md that is odd, huge or unreadable, and with nothing at all", () => {
    const dir = tmp();
    expect(loadDraft(dir)).toMatchObject({ exists: false, draft: { name: "gork", body: "", quirk: "" } });
    writeFileSync(join(dir, CUSTOM_FILE), "no front matter, just text");
    expect(loadDraft(dir).draft).toMatchObject({ name: "gork", body: "no front matter, just text" });
    writeFileSync(
      join(dir, CUSTOM_FILE),
      `---\nname: ${"n".repeat(500)}\nquirk_rate: lots\n---\n${"b".repeat(50_000)}`,
    );
    const big = loadDraft(dir).draft;
    expect(big.name.length).toBeLessThanOrEqual(CUSTOM_LIMITS.name);
    expect(big.body.length).toBeLessThanOrEqual(CUSTOM_LIMITS.body);
    expect(big.quirkRate).toBe(0);
    expect(loadDraft(join(dir, "missing"))).toMatchObject({ exists: false });
  });
});

describe("writeCustomFile", () => {
  const list = (dir: string) => readdirSync(dir).sort();

  it("writes custom.md, and nothing else is added or changed in the folder", () => {
    const dir = personas();
    const before = list(dir);
    const others = Object.fromEntries(before.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    writeCustomFile(dir, "---\nname: A\n---\nbody");
    expect(list(dir)).toEqual([...before, CUSTOM_FILE].sort());
    expect(readFileSync(join(dir, CUSTOM_FILE), "utf8")).toBe("---\nname: A\n---\nbody");
    for (const f of before) expect(readFileSync(join(dir, f), "utf8")).toBe(others[f]);
  });

  it("replaces an existing custom.md whole, and leaves no temporary file", () => {
    const dir = tmp();
    writeFileSync(join(dir, CUSTOM_FILE), "old");
    writeCustomFile(dir, "new");
    expect(readFileSync(join(dir, CUSTOM_FILE), "utf8")).toBe("new");
    expect(list(dir)).toEqual([CUSTOM_FILE]);
  });

  it("creates the folder when it is missing", () => {
    const dir = join(tmp(), "personas");
    writeCustomFile(dir, "x");
    expect(list(dir)).toEqual([CUSTOM_FILE]);
  });

  it("fails cleanly, leaving the old file and no temporary file, when it can't put the file in place", () => {
    const dir = tmp();
    mkdirSync(join(dir, CUSTOM_FILE)); // a folder where the file should go: the rename can't work
    expect(() => writeCustomFile(dir, "new")).toThrow(/custom\.md/);
    expect(list(dir)).toEqual([CUSTOM_FILE]);
  });

  it("replaces a link at custom.md instead of writing through it", () => {
    const dir = tmp();
    const outside = join(tmp(), "outside.txt");
    writeFileSync(outside, "keep me");
    try {
      symlinkSync(outside, join(dir, CUSTOM_FILE));
    } catch {
      return; // links need a privilege on some systems: nothing to check there
    }
    writeCustomFile(dir, "new");
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(readFileSync(join(dir, CUSTOM_FILE), "utf8")).toBe("new");
  });
});

describe("the docs about the editor", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("state the limits the editor enforces", () => {
    const guide = read("../docs/personalities.md");
    expect(guide).toContain(`up to ${CUSTOM_LIMITS.name} characters`);
    expect(guide).toContain(`up to ${CUSTOM_LIMITS.body.toLocaleString("en-US")} characters`);
  });
});
