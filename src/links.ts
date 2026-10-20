// Which links gork may open and preview. A page the model reads can tell it to fetch or post a link that carries
// chat text to someone else's server; limiting it to links people actually gave closes that path.

import type { Msg } from "./context.ts";

// http(s) links as Discord's own linkifier finds them: up to whitespace or "<" (Discord doesn't stop at ">").
const LINK = /https?:\/\/[^\s<]+/gi;
// A domain typed without a scheme ("example.com/page"); never part of an email address or a longer URL.
const BARE =
  /(?<![\p{L}\p{N}_@./:-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?![\p{L}\p{N}_@-])(?:\/[^\s<]*)?/giu;
/** Punctuation that usually ends a sentence or wraps a link rather than belonging to it. */
const TRAILING = ".,:;!?'\"]}>*_~|";

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** The link without trailing punctuation; a ")" goes only when it has no "(" to match, so wiki links keep theirs. */
function trimEnd(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s.at(-1);
    if (last && TRAILING.includes(last)) s = s.slice(0, -1);
    else if (last === ")" && count(s, "(") < count(s, ")")) s = s.slice(0, -1);
    else return s;
  }
}

/** The link as Discord reads it when it makes a preview: these trailing characters are never part of it. */
const discordReading = (raw: string) => raw.replace(/[.,:;"')\]]+$/, "");

/** Every way a link in text can be read, so the same link written twice gives the same keys. */
const readings = (raw: string) => [raw, trimEnd(raw), discordReading(raw)];

/**
 * The part of a link that says where it goes: scheme, credentials, host, path and query. The host is lowercased,
 * the fragment dropped and one trailing "/" ignored. Null for anything but an http(s) URL.
 */
export function linkKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const who = u.username || u.password ? `${u.username}:${u.password}@` : "";
  const path = u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
  return `${u.protocol}//${who}${u.host}${path}${u.search}`;
}

/** A set of links compared by linkKey. */
export class LinkSet {
  private keys = new Set<string>();
  /** Hosts whose every page may be opened: the sites the operator's personality names. */
  private sites = new Set<string>();

  constructor(texts: string[] = []) {
    for (const text of texts) this.addText(text);
  }

  /** Adds every link in the text, including domains typed without a scheme (as both http and https). */
  addText(text: string): void {
    for (const [raw] of text.matchAll(LINK)) for (const r of readings(raw)) this.add(r);
    for (const [raw] of text.replace(LINK, " ").matchAll(BARE)) {
      for (const r of readings(raw)) {
        this.add(`https://${r}`);
        this.add(`http://${r}`);
      }
    }
  }

  /**
   * Trusts every page on each site the text links to. For the operator's own instructions: the sites they chose
   * aren't someone a web page could send chat text to.
   */
  addSites(text: string): void {
    for (const [raw] of text.matchAll(LINK)) {
      try {
        const u = new URL(trimEnd(raw));
        if (u.protocol === "http:" || u.protocol === "https:") this.sites.add(u.host.toLowerCase());
      } catch {
        // not a URL
      }
    }
  }

  add(url: string): void {
    const key = linkKey(url);
    if (key) this.keys.add(key);
  }

  has(url: string): boolean {
    const key = linkKey(url);
    if (key === null) return false;
    if (this.keys.has(key)) return true;
    const u = new URL(url);
    return !u.username && !u.password && this.sites.has(u.host.toLowerCase());
  }

  list(): string[] {
    return [...this.keys];
  }

  copy(): LinkSet {
    const out = new LinkSet();
    for (const key of this.keys) out.keys.add(key);
    for (const site of this.sites) out.sites.add(site);
    return out;
  }
}

// The target of a markdown link, "[text](target)", which may be relative to the page.
const MARKDOWN_TARGET = /\]\(([^)\s]+)\)/g;

/**
 * Links printed on a page gork read that stay on its site (the page's host without "www.", or a subdomain of it),
 * relative ones resolved against the page. A page is written before the chat it's read for, so a link printed on
 * it can't carry chat text; only a URL the model builds could. Fragments are dropped.
 */
export function sameSiteLinks(pageUrl: string, text: string): string[] {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return [];
  }
  const root = page.hostname.toLowerCase().replace(/^www\./, "");
  const out = new Set<string>();
  const consider = (raw: string) => {
    try {
      const u = new URL(raw, page);
      const host = u.hostname.toLowerCase();
      if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return;
      if (host !== root && !host.endsWith(`.${root}`)) return;
      u.hash = "";
      out.add(u.href);
    } catch {
      // not a URL
    }
  };
  for (const [, target] of text.matchAll(MARKDOWN_TARGET)) consider(target);
  for (const [raw] of text.matchAll(LINK)) consider(trimEnd(raw));
  return [...out];
}

/**
 * The links the asker gave: in their question and in the message they replied to, with those messages' embeds.
 * A replied-to message of gork's own doesn't count, since its links came from the model.
 */
export function givenLinks(question: Msg, replyTo: Msg | null): LinkSet {
  const replied = replyTo && !replyTo.isSelf ? [replyTo.content, ...replyTo.embeds] : [];
  return new LinkSet([question.content, ...question.embeds, ...replied]);
}

/**
 * Whether a reply message should go out with link previews turned off: it has a link the asker didn't give.
 * Discord fetches a previewed link itself, so a link carrying chat text would reach its server without a click.
 */
export function hidesPreviews(text: string, given: LinkSet): boolean {
  for (const [raw] of text.matchAll(LINK)) {
    if (![trimEnd(raw), discordReading(raw)].every((r) => given.has(r))) return true;
  }
  return false;
}
