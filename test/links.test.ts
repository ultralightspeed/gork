import { describe, expect, it } from "vitest";
import type { Msg } from "../src/context.ts";
import { givenLinks, hidesPreviews, LinkSet, linkKey, sameSiteLinks } from "../src/links.ts";

const msg = (content: string, over: Partial<Msg> = {}): Msg => ({
  authorName: "amy",
  isSelf: false,
  content,
  attachments: [],
  embeds: [],
  ...over,
});

describe("linkKey", () => {
  it("keeps scheme, host, path and query, drops the fragment and one trailing slash, and is null for anything but http(s)", () => {
    expect(linkKey("HTTPS://Example.COM/a/b/?x=1#top")).toBe("https://example.com/a/b?x=1");
    expect(linkKey("https://example.com/")).toBe("https://example.com");
    expect(linkKey("https://example.com")).toBe("https://example.com");
    for (const other of ["ftp://example.com/a", "javascript:alert(1)", "not a url"]) expect(linkKey(other)).toBeNull();
  });

  it("keeps credentials in the key, so a link can't carry text in front of the host unnoticed", () => {
    expect(linkKey("https://secret@example.com/a")).not.toBe(linkKey("https://example.com/a"));
  });
});

describe("LinkSet", () => {
  it("holds the links in text, tolerating a trailing slash, a fragment and the host's case", () => {
    const links = new LinkSet(["look at https://example.com/news/today and tell me"]);
    expect(links.has("https://example.com/news/today")).toBe(true);
    expect(links.has("https://example.com/news/today/")).toBe(true);
    expect(links.has("https://EXAMPLE.com/news/today#part-2")).toBe(true);
  });

  it("needs the query to match exactly, so nothing can be appended to a given link", () => {
    const links = new LinkSet(["https://example.com/page?id=7"]);
    expect(links.has("https://example.com/page?id=7")).toBe(true);
    expect(links.has("https://example.com/page?id=7&d=secret")).toBe(false);
    expect(links.has("https://example.com/page")).toBe(false);
    expect(links.has("https://example.com/page/more")).toBe(false);
  });

  it("reads links the way people write them in chat: punctuation after, <> around, masked, in parentheses", () => {
    const links = new LinkSet([
      "first https://a.example/one. then <https://b.example/two>, and [docs](https://c.example/three)!",
      "the film (https://en.wikipedia.org/wiki/Heat_(1995_film)) is good",
    ]);
    for (const url of [
      "https://a.example/one",
      "https://b.example/two",
      "https://c.example/three",
      "https://en.wikipedia.org/wiki/Heat_(1995_film)",
    ])
      expect(links.has(url), url).toBe(true);
  });

  it("counts a bare domain someone typed, on either scheme, but not an email address", () => {
    const links = new LinkSet(["summarize example.com/article for me, or mail bob@other.example"]);
    expect(links.has("https://example.com/article")).toBe(true);
    expect(links.has("http://example.com/article")).toBe(true);
    expect(links.has("https://example.com/other")).toBe(false);
    expect(links.has("https://other.example")).toBe(false);
  });

  it("takes more links later (web_search results), and a copy never feeds them back to the original", () => {
    const given = new LinkSet(["https://a.example/x"]);
    const allowed = given.copy();
    expect(allowed.has("https://news.example/story")).toBe(false);
    allowed.add("https://news.example/story");
    allowed.add("not a link"); // a search result that isn't a link adds nothing
    expect(allowed.has("https://news.example/story")).toBe(true);
    expect(allowed.has("https://a.example/x")).toBe(true);
    expect(given.has("https://news.example/story")).toBe(false);
    expect(allowed.list()).toEqual(["https://a.example/x", "https://news.example/story"]);
  });
});

describe("givenLinks", () => {
  it("takes the links in the question and the replied-to message, with their embeds", () => {
    const links = givenLinks(
      msg("what about https://q.example/1"),
      msg("see this", { embeds: ["A title — https://r.example/2 — a description"] }),
    );
    expect(links.has("https://q.example/1")).toBe(true);
    expect(links.has("https://r.example/2")).toBe(true);
  });

  it("doesn't count links in gork's own replied-to message, which came from the model", () => {
    const links = givenLinks(msg("what's this?"), msg("read https://evil.example/c?d=secret", { isSelf: true }));
    expect(links.has("https://evil.example/c?d=secret")).toBe(false);
  });
});

describe("hidesPreviews", () => {
  const given = givenLinks(msg("thoughts on https://news.example/story?"), null);

  it("keeps previews for text with no links, or only links the asker gave", () => {
    expect(hidesPreviews("no links here", given)).toBe(false);
    expect(hidesPreviews("It's about cats: https://news.example/story.", given)).toBe(false);
  });

  it("hides previews when any link is one the asker didn't give", () => {
    expect(hidesPreviews("source: https://other.example/page", given)).toBe(true);
    expect(hidesPreviews("https://news.example/story and https://other.example/page", given)).toBe(true);
    expect(hidesPreviews("[here](https://evil.example/c?d=secret)", given)).toBe(true);
  });

  it("hides previews when text is appended to a given link", () => {
    expect(hidesPreviews("https://news.example/story?d=secret", given)).toBe(true);
    expect(hidesPreviews("https://news.example/story>secret", given)).toBe(true);
    // Discord drops only . , : ; " ' ) ] from the end of a link, so a trailing _ or * is part of the link it fetches.
    expect(hidesPreviews("https://news.example/story_", given)).toBe(true);
    expect(hidesPreviews("https://news.example/story*", given)).toBe(true);
    expect(hidesPreviews("https://news.example/story/secret", given)).toBe(true);
  });
});

describe("LinkSet sites from the operator's personality", () => {
  it("open any page on a site the personality names", () => {
    const set = new LinkSet();
    set.addSites("read https://www.wowhead.com/forever/changes/talents/<class> for a class");
    expect(set.has("https://www.wowhead.com/forever/changes/talents/hunter")).toBe(true);
    expect(set.has("https://www.wowhead.com/search?q=skyborne")).toBe(true);
    expect(set.has("http://www.wowhead.com/forever")).toBe(true);
  });

  it("stay on that host: other hosts and lookalikes are not trusted", () => {
    const set = new LinkSet();
    set.addSites("https://www.wowhead.com/forever/changes");
    expect(set.has("https://evil.example/forever/changes")).toBe(false);
    expect(set.has("https://www.wowhead.com.evil.example/x")).toBe(false);
    expect(set.has("https://wowhead.com/x")).toBe(false);
  });

  it("are carried by copy()", () => {
    const set = new LinkSet();
    set.addSites("https://www.wowhead.com/forever/changes");
    expect(set.copy().has("https://www.wowhead.com/forever/changes/talents/rogue")).toBe(true);
  });
});

describe("sameSiteLinks", () => {
  const page = "https://www.wowhead.com/forever/changes";
  it("returns the page's links on the same site, absolute or relative", () => {
    const text =
      "[a](https://www.wowhead.com/forever/x) [b](/forever/y) see https://classic.wowhead.com/z [c](https://evil.example/w)";
    expect(sameSiteLinks(page, text).sort()).toEqual(
      [
        "https://classic.wowhead.com/z",
        "https://www.wowhead.com/forever/x",
        "https://www.wowhead.com/forever/y",
      ].sort(),
    );
  });

  it("leaves out lookalike hosts and other schemes", () => {
    const text = "https://www.wowhead.com.evil.example/a https://notwowhead.com/b [c](javascript:alert(1))";
    expect(sameSiteLinks(page, text)).toEqual([]);
  });
});
