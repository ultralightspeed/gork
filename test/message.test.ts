import { describe, expect, it } from "vitest";
import { forwardedText, imageSources, resolveNames, toMsg, videoSources, withForwards } from "../src/message.ts";

const snap = {
  content: "worth a listen",
  attachments: new Map([["1", { url: "https://cdn.discordapp.com/a.png", contentType: "image/png" }]]),
  embeds: [{ title: "Patch 2.1 notes", description: "What changed this week", fields: [] }],
};
const forward = { content: "", attachments: new Map(), embeds: [], messageSnapshots: new Map([["9", snap]]) };
const plain = { content: "hi", attachments: new Map(), embeds: [], messageSnapshots: new Map() };

describe("forwarded messages", () => {
  it("treats a forward's snapshot as part of the message", () => {
    expect(withForwards(forward)).toEqual([forward, snap]);
    expect(withForwards(plain)).toEqual([plain]);
    const { messageSnapshots: _, ...bare } = plain;
    expect(withForwards(bare)).toEqual([bare]);
  });

  it("labels forwarded text so the model knows where it came from", () => {
    expect(forwardedText(forward)).toBe("[forwarded message] worth a listen");
    expect(forwardedText(plain)).toBe("");
  });
});

const msg = (o: Record<string, unknown> = {}) => ({
  content: "",
  attachments: new Map(),
  embeds: [],
  author: { id: "10", username: "alice_u" },
  ...o,
});

describe("toMsg", () => {
  it("names the author by server nickname, then display name, then username", () => {
    const author = { id: "10", username: "alice_u", displayName: "Alice" };
    expect(toMsg(msg({ author, member: { displayName: "Ali" } }), "", "99").authorName).toBe("Ali");
    expect(toMsg(msg({ author, member: null }), "", "99").authorName).toBe("Alice");
    expect(toMsg(msg(), "", "99").authorName).toBe("alice_u");
  });

  it("marks the bot's own messages", () => {
    expect(toMsg(msg(), "", "10").isSelf).toBe(true);
    expect(toMsg(msg(), "", "99").isSelf).toBe(false);
    expect(toMsg(msg(), "", undefined).isSelf).toBe(false);
  });

  it("appends forwarded text to the given content", () => {
    expect(toMsg({ ...forward, author: msg().author }, "look", "99").content).toBe(
      "look\n[forwarded message] worth a listen",
    );
    expect(toMsg({ ...forward, author: msg().author }, "", "99").content).toBe("[forwarded message] worth a listen");
  });

  it("lists the images gork could look at apart from the other attachments, from the message and its snapshots", () => {
    const own = msg({
      attachments: new Map([
        ["1", { url: "https://cdn.discordapp.com/attachments/1/2/a.png", contentType: "image/png" }],
        ["2", { url: "https://cdn.discordapp.com/attachments/1/2/notes.pdf", contentType: "application/pdf" }],
        ["3", { url: "https://cdn.discordapp.com/attachments/1/2/b.heic", contentType: "image/heic" }],
        ["4", { url: "https://cdn.discordapp.com/attachments/1/2/blob", contentType: null }],
      ]),
      embeds: [
        { title: "Own", fields: [], image: { proxyURL: "https://images-ext-1.discordapp.net/external/x/y.jpg" } },
      ],
      messageSnapshots: new Map([["9", snap]]),
    });
    const out = toMsg(own, "", "99");
    // In imageSources order: each part's attachments, then its embed images; the message first, then its snapshots.
    expect(out.images).toEqual([
      "https://media.discordapp.net/attachments/1/2/a.png",
      "https://images-ext-1.discordapp.net/external/x/y.jpg",
      "https://media.discordapp.net/a.png",
    ]);
    // An image of a type gork can't look at stays an attachment, like any other file.
    expect(out.attachments).toEqual(["application/pdf", "image/heic", "file"]);
    expect(out.embeds).toEqual(["Own", "Patch 2.1 notes - What changed this week"]);
  });

  it("writes embed text as title, URL, description and fields, skipping empty embeds", () => {
    const embeds = [
      {
        title: "Patch 11.2",
        url: "https://example.com/patch",
        description: "big changes",
        fields: [{ name: "Tank", value: "nerfed" }],
      },
      { title: null, url: null, description: null, fields: [] },
    ];
    expect(toMsg(msg({ embeds }), "", "99").embeds).toEqual([
      "Patch 11.2 - https://example.com/patch - big changes - Tank: nerfed",
    ]);
  });
});

describe("resolveNames", () => {
  const mentions = {
    members: new Map([["1", { displayName: "Nick" }]]),
    users: new Map([
      ["1", { username: "nick_u" }],
      ["2", { username: "bob_u" }],
    ]),
  };
  const guild = { roles: { cache: new Map([["7", { name: "mods" }]]) } };

  it("resolves user mentions (preferring the server nickname) and role mentions", () => {
    expect(resolveNames({ mentions, guild }, "hi <@1> and <@!2>, ping <@&7>")).toBe("hi @Nick and @bob_u, ping @mods");
  });

  it("falls back to @someone and @role for unknown ids", () => {
    expect(resolveNames({ mentions, guild }, "<@3> <@&8>")).toBe("@someone @role");
    expect(resolveNames({ mentions: { members: null, users: new Map() }, guild: null }, "<@1> <@&7>")).toBe(
      "@someone @role",
    );
  });
});

describe("imageSources: sizes", () => {
  it("passes on each image's width and height, which the media proxy needs to shrink it without cropping", () => {
    const m = msg({
      attachments: new Map([["1", { url: "https://cdn/a.png", contentType: "image/png", width: 1400, height: 150 }]]),
      embeds: [{ fields: [], image: { proxyURL: "https://proxy/img", width: 640, height: 360 }, thumbnail: null }],
    });
    expect(imageSources(m)).toEqual([
      { url: "https://cdn/a.png", contentType: "image/png", width: 1400, height: 150 },
      { url: "https://proxy/img", width: 640, height: 360 },
    ]);
  });
});

describe("imageSources", () => {
  const embedWith = (image?: string, thumbnail?: string) => ({
    fields: [],
    image: image ? { proxyURL: image } : null,
    thumbnail: thumbnail ? { proxyURL: thumbnail } : null,
  });

  it("takes attachments, then embed image and thumbnail proxy URLs", () => {
    const m = msg({
      attachments: new Map([["1", { url: "https://cdn/a.png", contentType: "image/png" }]]),
      embeds: [embedWith("https://proxy/img", "https://proxy/thumb"), embedWith(), { fields: [], image: {} }],
    });
    expect(imageSources(m)).toEqual([
      { url: "https://cdn/a.png", contentType: "image/png" },
      { url: "https://proxy/img" },
      { url: "https://proxy/thumb" },
    ]);
  });

  it("includes images from forward snapshots", () => {
    const m = msg({
      messageSnapshots: new Map([["9", { ...snap, embeds: [embedWith("https://proxy/fwd")] }]]),
    });
    expect(imageSources(m)).toEqual([
      { url: "https://cdn.discordapp.com/a.png", contentType: "image/png" },
      { url: "https://proxy/fwd" },
    ]);
  });
});

describe("videoSources", () => {
  const clip = { url: "https://cdn.discordapp.com/v.mp4", contentType: "video/mp4" };

  it("takes attachments with their size, length and resolution; only the attachment's own fields", () => {
    const m = msg({
      attachments: new Map([
        ["1", { ...clip, size: 1234, duration: 12.5, width: 640, height: 360, name: "ignored" }],
        ["2", { url: "https://cdn.discordapp.com/a.png", contentType: "image/png" }],
      ]),
    });
    expect(videoSources(m)).toEqual([
      { url: clip.url, contentType: "video/mp4", size: 1234, durationSec: 12.5, width: 640, height: 360 },
      { url: "https://cdn.discordapp.com/a.png", contentType: "image/png" },
    ]);
  });

  it("includes videos from forward snapshots", () => {
    const own = { url: "https://cdn.discordapp.com/own.mp4", contentType: "video/mp4" };
    const m = msg({
      attachments: new Map([["0", own]]),
      messageSnapshots: new Map([["9", { ...snap, attachments: new Map([["1", clip]]) }]]),
    });
    expect(videoSources(m).map((s) => s.url)).toEqual([own.url, clip.url]);
  });
});
