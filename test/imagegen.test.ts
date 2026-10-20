import { describe, expect, it } from "vitest";
import { FreeAllowanceError } from "../src/cf.ts";
import { generateImage } from "../src/imagegen.ts";
import { newToolState } from "../src/tools.ts";
import { type Call, callTool, fakeFetch as fake, json, testConfig } from "./helpers.ts";

const cfg = testConfig();
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const FLUX =
  "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/black-forest-labs/flux-1-schnell";
const CLEF =
  "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef-flash";
const clean = { S1: 0, S3: 0, S4: 0, S9: 0, S11: 0 };
const answers = (scores: Record<string, number>) => ({
  result: { answers: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { type: "noul", noul: v }])) },
});

describe("generateImage", () => {
  it("calls FLUX.1 schnell directly (free allowance, no gateway) and returns the JPEG", async () => {
    const { f, calls } = fake(() => json({ success: true, result: { image: JPEG.toString("base64") } }));
    const img = await generateImage(cfg, "an orc accountant", f);
    expect(calls[0].url).toBe(FLUX);
    expect(calls[0].headers["cf-aig-gateway-id"]).toBeUndefined();
    expect(calls[0].body.prompt).toBe("an orc accountant");
    expect(img.data.equals(JPEG)).toBe(true);
  });

  it("does not retry when a successful image just happens to contain the text 3036 (the bug that charged credits)", async () => {
    const tricky = Buffer.concat([JPEG, Buffer.from("....3036....")]);
    const { f, calls } = fake(() => json({ success: true, result: { image: `${tricky.toString("base64")}3036` } }));
    await generateImage(cfg, "x", f).catch(() => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["cf-aig-gateway-id"]).toBeUndefined();
  });

  it("accepts an image whose base64 is larger than the default response cap", async () => {
    const png = Buffer.alloc(6 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const { f } = fake(() => json({ success: true, result: { image: png.toString("base64") } }));
    expect((await generateImage(cfg, "x", f)).data.length).toBe(png.length);
  });

  it("never falls back to paid credits when the free allowance is used up", async () => {
    const { f, calls } = fake(() => json({ errors: [{ code: 3036, message: "daily free allocation" }] }, 429));
    await expect(generateImage(cfg, "x", f)).rejects.toBeInstanceOf(FreeAllowanceError);
    expect(calls).toHaveLength(1);
  });

  it("throws on other errors and on non-image payloads", async () => {
    await expect(generateImage(cfg, "x", fake(() => json({}, 500)).f)).rejects.toThrow();
    await expect(
      generateImage(cfg, "x", fake(() => json({ result: { image: Buffer.from("hello").toString("base64") } })).f),
    ).rejects.toThrow(/not an image/);
  });
});

describe("generate_image tool", () => {
  const route = (clef: Record<string, number>) => (c: Call) =>
    c.url === FLUX
      ? json({ result: { image: JPEG.toString("base64") } })
      : c.url === CLEF
        ? json(answers(clef))
        : json({}, 404);

  it("returns the image as an attachment carrying its prompt, for respond() to screen", async () => {
    const { f, calls } = fake(route(clean));
    const r = await callTool(cfg, "generate_image", JSON.stringify({ prompt: "orc accountant" }), { fetch: f });
    expect(r.attachment?.data.equals(JPEG)).toBe(true);
    expect(r.attachment).toMatchObject({ name: expect.stringMatching(/\.jpg$/), prompt: "orc accountant" });
    expect(r.content).toMatch(/attached/i);
    expect(calls.map((c) => c.url)).toEqual([FLUX]);
  });

  it("tells the model when the free allowance is used up, and charges nothing", async () => {
    const { f, calls } = fake((c) => (c.url === FLUX ? json({ errors: [{ code: 3036 }] }, 429) : json(answers(clean))));
    const r = await callTool(cfg, "generate_image", JSON.stringify({ prompt: "x y" }), { fetch: f });
    expect(r.attachment).toBeUndefined();
    expect(r.costUsd).toBe(0);
    expect(r.content).toMatch(/free/i);
    expect(calls.filter((c) => c.url === FLUX)).toHaveLength(1);
  });

  it("refuses a third image in one reply and respects the daily cap", async () => {
    const { f } = fake(route(clean));
    expect(
      (
        await callTool(cfg, "generate_image", JSON.stringify({ prompt: "x y" }), {
          fetch: f,
          tally: { images: 2, polls: 0, events: 0 },
        })
      ).content,
    ).toMatch(/2 images/);
    const capped = testConfig({ IMAGES_PER_DAY: "1" });
    const deps = { fetch: f, state: newToolState(capped) };
    const make = () => callTool(capped, "generate_image", JSON.stringify({ prompt: "x y" }), deps);
    expect((await make()).attachment).toBeDefined();
    expect((await make()).content).toMatch(/daily/i);
  });
});
