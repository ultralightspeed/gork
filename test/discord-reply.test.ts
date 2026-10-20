import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import { type Replyable, type ReplyPayload, sendReply } from "../src/discord-reply.ts";
import { LinkSet } from "../src/links.ts";
import { NO_PINGS, type Pinged } from "../src/mentions.ts";

/** A message that records every reply made to it and to the replies it returns, in order. */
function channel(failAt = -1) {
  const sent: { to: number; payload: ReplyPayload }[] = [];
  const message = (id: number): Replyable => ({
    reply: async (payload) => {
      if (sent.length === failAt) throw new Error("Missing Permissions");
      sent.push({ to: id, payload });
      return message(sent.length);
    },
  });
  return { root: message(0), sent };
}

const pingAll = (first: string): Pinged => ({
  text: first,
  allowedMentions: { parse: ["everyone"], users: ["1"], roles: [], repliedUser: true },
});
const image = { name: "a.png", data: Buffer.from([1, 2, 3]) };
const long = `${"a ".repeat(1200)}@everyone ${"b ".repeat(600)}`;

describe("sendReply", () => {
  it("posts a short reply as one message with the files and the first chunk's pings", async () => {
    const { root, sent } = channel();
    await sendReply(root, { text: "hi @everyone", files: [image], given: new LinkSet(), ping: pingAll }, () => {});
    expect(sent).toEqual([
      {
        to: 0,
        payload: {
          content: "hi @everyone",
          allowedMentions: pingAll("").allowedMentions,
          files: [{ attachment: image.data, name: "a.png" }],
        },
      },
    ]);
  });

  it("chains later chunks as replies to the previous one, without files or pings", async () => {
    const { root, sent } = channel();
    await sendReply(root, { text: long, files: [image], given: new LinkSet(), ping: pingAll }, () => {});
    expect(sent.map((s) => s.to)).toEqual([0, 1]);
    expect(sent[1].payload.allowedMentions).toEqual(NO_PINGS);
    expect(sent[1].payload.files).toBeUndefined();
  });

  it("defuses @everyone in later chunks", async () => {
    const { root, sent } = channel();
    await sendReply(root, { text: long, files: [], given: new LinkSet(), ping: pingAll }, () => {});
    expect(sent[1].payload.content).toContain("everyone");
    expect(sent[1].payload.content).not.toContain("@everyone");
  });

  it("passes only the first chunk to ping", async () => {
    const seen: string[] = [];
    const { root } = channel();
    const ping = (first: string) => {
      seen.push(first);
      return pingAll(first);
    };
    await sendReply(root, { text: long, files: [], given: new LinkSet(), ping }, () => {});
    expect(seen).toHaveLength(1);
    expect(long.startsWith(seen[0].trim())).toBe(true);
  });

  it("suppresses link previews on a chunk with a link the asker didn't give", async () => {
    const { root, sent } = channel();
    const given = new LinkSet(["https://given.example/page"]);
    const text = "see https://given.example/page and https://other.example/x";
    await sendReply(root, { text, files: [], given, ping: pingAll }, () => {});
    expect(sent[0].payload.flags).toBe(MessageFlags.SuppressEmbeds);
    const { root: root2, sent: sent2 } = channel();
    await sendReply(root2, { text: "see https://given.example/page", files: [], given, ping: pingAll }, () => {});
    expect(sent2[0].payload.flags).toBeUndefined();
  });

  it("suppresses link previews on every chunk when the asker can't embed links", async () => {
    const { root, sent } = channel();
    const reply = { text: long, files: [], given: new LinkSet(), ping: pingAll, previews: false };
    await sendReply(root, reply, () => {});
    expect(sent.map((s) => s.payload.flags)).toEqual([MessageFlags.SuppressEmbeds, MessageFlags.SuppressEmbeds]);
  });

  it("logs a failed send instead of throwing", async () => {
    const { root, sent } = channel(1);
    const lines: string[] = [];
    await sendReply(root, { text: long, files: [], given: new LinkSet(), ping: pingAll }, (l) => lines.push(l));
    expect(sent).toHaveLength(1);
    expect(lines).toEqual(["send failed: Error: Missing Permissions"]);
  });
});
