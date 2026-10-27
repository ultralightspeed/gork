import type { Message } from "discord.js";
import { describe, expect, it } from "vitest";
import type { Msg } from "../src/context.ts";
import { eventRefusal, pingContext, pollRefusal, splitImageUrls } from "../src/discord-access.ts";

type User = { id: string; bot: boolean; username: string; displayName: string };
const user = (id: string, bot = false): User => ({ id, bot, username: `u${id}`, displayName: `U${id}` });

/** Just enough of a discord.js Message for these readers. */
function message(o: { author?: User; mentions?: User[]; askerPerms?: string[]; botPerms?: string[] } = {}) {
  const perms = (list: string[] = []) => ({ permissions: { has: (p: string) => list.includes(p) } });
  return {
    author: o.author ?? user("1"),
    member: { displayName: "Asker", ...perms(o.askerPerms) },
    mentions: { users: new Map((o.mentions ?? []).map((u) => [u.id, u])), members: new Map() },
    channel: { permissionsFor: () => ({ has: () => false }) },
    guild: { id: "g", roles: { cache: new Map() }, members: { me: perms(o.botPerms) } },
  } as unknown as Message;
}

describe("splitImageUrls", () => {
  const withImages = (...images: string[]): Msg => ({
    authorName: "a",
    isSelf: false,
    content: "",
    attachments: [],
    embeds: [],
    images,
  });

  it("attaches up to 3 images, the asker's own first, keeping the replied-to message's apart", () => {
    expect(splitImageUrls(withImages("q1", "q2"), withImages("r1", "r2"))).toEqual({
      imageUrls: ["q1", "q2"],
      replyImageUrls: ["r1"],
    });
    expect(splitImageUrls(withImages("q1", "q2", "q3", "q4"), withImages("r1"))).toEqual({
      imageUrls: ["q1", "q2", "q3"],
      replyImageUrls: [],
    });
    expect(splitImageUrls(withImages(), null)).toEqual({ imageUrls: [], replyImageUrls: [] });
  });
});

describe("pingContext", () => {
  it("never offers a bot mentioned in the question as someone to ping", () => {
    const ctx = pingContext(message({ mentions: [user("2"), user("3", true)] }), [], {
      botId: "99",
      allowed: new Set(["users"]),
      everyoneRequested: false,
    });
    expect(ctx.people.map((p) => p.id).sort()).toEqual(["1", "2"]);
  });
});

describe("eventRefusal", () => {
  const both = { askerPerms: ["CreateEvents"], botPerms: ["CreateEvents"] };
  it("allows an event whenever the asker and gork both have Create Events, whatever the wording", () => {
    expect(eventRefusal(message(both))).toBeNull();
  });

  it("names the one permission that's missing", () => {
    expect(eventRefusal(message({ botPerms: ["CreateEvents"] }))).toMatch(/person asking doesn't have/);
    expect(eventRefusal(message({ askerPerms: ["CreateEvents"] }))).toMatch(/you don't have/);
  });
});

describe("pollRefusal", () => {
  it("allows a poll when both may post polls here, and otherwise says so", () => {
    expect(pollRefusal({ poll: true })).toBeNull();
    expect(pollRefusal({ poll: false })).toMatch(/may not post polls/);
  });
});
