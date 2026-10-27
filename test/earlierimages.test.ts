import { describe, expect, it } from "vitest";
import type { EarlierImage } from "../src/context.ts";
import { EARLIER_IMAGES_PER_CALL, EARLIER_IMAGES_PER_REPLY, EarlierImages } from "../src/earlierimages.ts";
import type { GuardVerdict } from "../src/guard.ts";

const images: EarlierImage[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  number: n,
  url: `https://media.discordapp.net/attachments/1/${n}/i.png`,
  poster: n % 2 ? "bob" : "amy",
}));
const data = (n: number) => `data:image/png;base64,${Buffer.from(`image ${n}`).toString("base64")}`;
const numberOf = (dataUrl: string) => Number(Buffer.from(dataUrl.split(",")[1], "base64").toString().split(" ")[1]);
const clean: GuardVerdict = { blocked: false, costUsd: 0.00004 };
const flagged: GuardVerdict = { blocked: true, category: "S4", p: 0.95, selfHarm: false, costUsd: 0.00004 };

/** EarlierImages over six images, with a fake download and a fake guard that record what they were asked. */
function setup(
  o: { download?: (n: number) => string | null; screen?: (n: number) => GuardVerdict; room?: number } = {},
) {
  const downloaded: number[] = [];
  const screened: number[] = [];
  const log: string[] = [];
  const earlier = new EarlierImages(
    images,
    {
      download: async (url) => {
        const n = images.find((i) => i.url === url)?.number ?? 0;
        downloaded.push(n);
        return o.download ? o.download(n) : data(n);
      },
      screen: async (shown) => {
        expect(shown).toHaveLength(1); // each image is screened on its own, so one can't hide another
        const n = numberOf(shown[0]);
        screened.push(n);
        return o.screen ? o.screen(n) : clean;
      },
      log: (line) => log.push(line),
    },
    o.room,
  );
  return { earlier, downloaded, screened, log };
}
const shownNumbers = (r: { images: { label: string }[] }) => r.images.map((i) => i.label);

describe("view_images: showing images posted earlier in the chat", () => {
  it("shows the asked images in the order asked, each screened first, labelled with its number and its poster", async () => {
    const t = setup();
    const r = await t.earlier.view({ numbers: [3, 2] });
    expect(r.images).toEqual([
      { label: "Image #3, posted by bob", dataUrl: data(3) },
      { label: "Image #2, posted by amy", dataUrl: data(2) },
    ]);
    expect(t.screened.sort()).toEqual([2, 3]);
    expect(r.costUsd).toBeCloseTo(2 * clean.costUsd, 10);
    expect(r.text).toMatch(/follow in the next message/);
    expect(r.text).toMatch(/untrusted/);
    expect(t.earlier.shown).toBe(2);
  });

  it("accepts one number on its own, or numbers written as strings", async () => {
    expect(shownNumbers(await setup().earlier.view({ numbers: 4 }))).toEqual(["Image #4, posted by amy"]);
    expect(shownNumbers(await setup().earlier.view({ numbers: ["5"] }))).toEqual(["Image #5, posted by bob"]);
  });

  it.each([[{}], [{ numbers: [] }], [{ numbers: "two" }], [{ numbers: [1.5] }], [{ images: [1] }]])(
    "teaches the model how to ask, without fetching anything, when given %j",
    async (args) => {
      const t = setup();
      const r = await t.earlier.view(args);
      expect(r.images).toEqual([]);
      expect(r.text).toContain('{"numbers": [2]}');
      expect(r.text).toContain("#1 to #6");
      expect(t.downloaded).toEqual([]);
    },
  );

  it("says which numbers the chat doesn't have, and shows the rest", async () => {
    const t = setup();
    const r = await t.earlier.view({ numbers: [9, 2] });
    expect(shownNumbers(r)).toEqual(["Image #2, posted by amy"]);
    expect(r.text).toContain("There is no image #9");
    expect(r.text).toContain("#1 to #6");
    const none = await t.earlier.view({ numbers: [42] });
    expect(none.images).toEqual([]);
    expect(none.text).toContain("There is no image #42");
    expect(t.downloaded).toEqual([2]);
    expect((await t.earlier.view({ numbers: [7, 8, 9] })).text).toContain("There is no image #7, #8 or #9");
  });

  it(`shows at most ${EARLIER_IMAGES_PER_CALL} per call, and names the ones it left for another call`, async () => {
    const t = setup();
    const r = await t.earlier.view({ numbers: [1, 2, 3, 4] });
    expect(r.images).toHaveLength(EARLIER_IMAGES_PER_CALL);
    expect(t.downloaded.sort()).toEqual([1, 2, 3]);
    expect(r.text).toMatch(/#4 wasn't shown/);
  });

  it(`stops at ${EARLIER_IMAGES_PER_REPLY} a reply, and says so instead of fetching more`, async () => {
    const t = setup();
    await t.earlier.view({ numbers: [1, 2, 3] });
    const second = await t.earlier.view({ numbers: [4, 5] });
    expect(shownNumbers(second)).toEqual(["Image #4, posted by amy"]);
    expect(second.text).toMatch(/#5 wasn't shown/);
    const third = await t.earlier.view({ numbers: [6] });
    expect(third.images).toEqual([]);
    expect(third.text).toMatch(/used up/);
    expect(t.downloaded.sort()).toEqual([1, 2, 3, 4]);
    expect(t.earlier.shown).toBe(EARLIER_IMAGES_PER_REPLY);
  });

  it("says the reply's limit is reached only once it really is", async () => {
    const t = setup({ download: (n) => (n === 4 ? null : data(n)) });
    await t.earlier.view({ numbers: [1, 2, 3] });
    const r = await t.earlier.view({ numbers: [4, 5] }); // room for one: #4, which then fails
    expect(r.text).not.toMatch(/limit/);
    expect(r.text).toContain("#5 wasn't shown in this call");
    expect(r.text).not.toContain("Answer from what you have");
    expect(t.earlier.shown).toBe(3);
  });

  it("says in words how many more it can still show", async () => {
    const t = setup();
    expect((await t.earlier.view({ numbers: [1, 2, 3] })).text).toContain(
      "1 more earlier image can still be shown in this reply.",
    );
    expect((await t.earlier.view({ numbers: [4] })).text).toContain(
      "No more earlier images can be shown in this reply.",
    );
  });

  it("allows fewer a reply when the request has less room left for images", async () => {
    const t = setup({ room: 2 });
    const r = await t.earlier.view({ numbers: [1, 2, 3] });
    expect(r.images).toHaveLength(2);
    expect((await t.earlier.view({ numbers: [4] })).text).toMatch(/used up/);
  });

  it("doesn't fetch or send again an image this reply already showed", async () => {
    const t = setup();
    await t.earlier.view({ numbers: [1] });
    const r = await t.earlier.view({ numbers: [1, 2] });
    expect(shownNumbers(r)).toEqual(["Image #2, posted by amy"]);
    expect(r.text).toContain("Image #1 was already shown");
    expect(t.downloaded.sort()).toEqual([1, 2]);
    expect(t.earlier.shown).toBe(2);
    expect((await t.earlier.view({ numbers: [1, 2] })).text).toContain("Images #1 and #2 were already shown");
  });

  it("leaves out an image it couldn't download, says so, and doesn't count it", async () => {
    const t = setup({ download: (n) => (n === 2 ? null : data(n)) });
    const r = await t.earlier.view({ numbers: [1, 2, 3] });
    expect(shownNumbers(r)).toEqual(["Image #1, posted by bob", "Image #3, posted by bob"]);
    expect(r.text).toContain("Image #2 couldn't be downloaded");
    expect(r.text).toMatch(/Image #2 couldn't be downloaded\. Don't guess what it shows\./);
    expect(t.screened.sort()).toEqual([1, 3]);
    expect(t.earlier.shown).toBe(2);
  });

  it("doesn't fetch or pay again for an image it couldn't show, and says why again", async () => {
    const t = setup({ screen: (n) => (n === 2 ? flagged : clean) });
    await t.earlier.view({ numbers: [2] });
    const again = await t.earlier.view({ numbers: [2] });
    expect(again.text).toContain("Image #2 can't be shown");
    expect(again.costUsd).toBe(0);
    expect(t.downloaded).toEqual([2]);
    expect(t.screened).toEqual([2]);
  });

  it("shows nothing the screen didn't clear, tells the model not to guess, and still pays for the check", async () => {
    const t = setup({ screen: (n) => (n === 2 ? flagged : clean) });
    const r = await t.earlier.view({ numbers: [1, 2] });
    expect(shownNumbers(r)).toEqual(["Image #1, posted by bob"]);
    expect(r.text).toContain("Image #2 can't be shown");
    expect(r.text).toMatch(/don't guess/i);
    expect(r.costUsd).toBeCloseTo(2 * clean.costUsd, 10);
    expect(t.earlier.shown).toBe(1);
    expect(t.log.join("\n")).toMatch(/image #2 not shown: S4/);
  });

  it("remembers a self-harm verdict, so the reply can be the fixed one instead of the model's", async () => {
    const harm: GuardVerdict = { blocked: true, category: "S11", p: 0.95, selfHarm: true, costUsd: 0.00004 };
    const t = setup({ screen: (n) => (n === 2 ? harm : clean) });
    await t.earlier.view({ numbers: [1] });
    expect(t.earlier.selfHarm).toBe(false);
    await t.earlier.view({ numbers: [2] });
    expect(t.earlier.selfHarm).toBe(true);
    const other = setup({ screen: () => flagged });
    await other.earlier.view({ numbers: [1] });
    expect(other.earlier.selfHarm).toBe(false); // blocked for another reason: just not shown
  });

  it("fails closed when the screen can't run, and logs it without throwing", async () => {
    const t = setup({
      screen: (n) => {
        if (n === 1) throw new Error("guard down");
        return clean;
      },
    });
    const r = await t.earlier.view({ numbers: [1, 3] });
    expect(shownNumbers(r)).toEqual(["Image #3, posted by bob"]);
    expect(r.text).toContain("Image #1 can't be shown");
    expect(r.text).toMatch(/couldn't run/);
    expect(t.log.join("\n")).toMatch(/view_images: screening image #1 failed \(failing closed\): guard down/);
  });
});
