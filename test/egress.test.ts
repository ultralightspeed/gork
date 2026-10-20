import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every host named in src/ and scripts/ (URLs, bare host names, host patterns), checked against a list with a reason
// for each. A new host fails here until someone decides it belongs and says why, here and in docs/audit.md.
// What this can't see: hosts that arrive at run time (LLM_BASE_URL, a YouTube caption track's address, which
// src/youtube.ts checks is www.youtube.com) and the hosts discord.js itself talks to.

type Kind =
  /** This computer (or its container engine) connects to it. */
  | "connects"
  /** Handed to Cloudflare, which fetches it; this computer never does. */
  | "via-cloudflare"
  /** A link shown to you or opened in your browser; the code never fetches it. */
  | "link"
  /** Accepted in a link someone posts, to read an ID from it; never contacted. */
  | "recognized"
  /** This computer itself (the setup page). */
  | "local";

const HOSTS: Record<string, [Kind, string]> = {
  "discord.com": [
    "connects",
    "setup and doctor call the Discord API (/api/v10); also Developer Portal and event links",
  ],
  "cdn.discordapp.com": ["connects", "attachments people post: videos are read from here (images go via the proxy)"],
  "media.discordapp.net": ["connects", "Discord's media proxy: images are downloaded through it, already shrunk"],
  "images-ext-*.discordapp.net": ["connects", "Discord's proxy for link-preview images"],
  "api.cloudflare.com": ["connects", "Workers AI, AI Gateway, web search, page reading and token setup"],
  "gateway.ai.cloudflare.com": ["connects", "the AI Gateway endpoint, when LLM_BASE_URL points at it"],
  "www.youtube.com": ["connects", "YouTube transcripts: the InnerTube player API and the caption track"],
  "ghcr.io": ["connects", "where npm run up has the container engine pull the released image from"],
  "example.com": ["via-cloudflare", "a test page for Cloudflare's page reader in setup and npm run probe"],
  "youtube.com": ["recognized", "YouTube links: the video ID is read from them"],
  "m.youtube.com": ["recognized", "YouTube links: the video ID is read from them"],
  "youtu.be": ["recognized", "YouTube short links: the video ID is read from them"],
  "www.youtube-nocookie.com": ["recognized", "YouTube embed links: the video ID is read from them"],
  "dash.cloudflare.com": ["link", "Cloudflare dashboard pages: sign-up, API tokens, AI Gateway credits"],
  "www.docker.com": ["link", "where to get Docker Desktop"],
  "podman-desktop.io": ["link", "where to get Podman Desktop"],
  "docs.docker.com": ["link", "how to install Docker Compose"],
  "github.com": ["link", "how to install podman-compose"],
  localhost: ["local", "the setup page, served on this computer only"],
  "127.0.0.1": ["local", "the setup page, served on this computer only"],
};

const TLDS = "com|net|org|io|dev|ai|gg|app|be|co|cloud|sh|me|tv|xyz";
const HOST_SHAPE = /^(?:localhost|(?:[a-z0-9*-]+\.)+[a-z0-9-]+)$/;
const PATTERNS: RegExp[] = [
  // Any URL: https://host, http://host, wss://host, also inside template literals.
  /\b(?:https?|wss?):\/\/([^\s"'`<>()\\/?#:]*)/gi,
  // A host name on its own in a string: "cdn.discordapp.com", "ghcr.io/you/gork".
  new RegExp(`["'\`]((?:[a-z0-9-]+\\.)+(?:${TLDS}))(?=["'\`/:])`, "gi"),
  // A host in a regular expression: /^images-ext-\d+\.discordapp\.net$/.
  new RegExp(`((?:[a-z0-9-]|\\\\d[+*])+(?:\\\\\\.[a-z0-9-]+)*\\\\\\.(?:${TLDS}))\\b`, "gi"),
];

/** The text without whole-line comments, which name hosts (documentation links) the code never uses. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|<!--)/.test(line))
    .join("\n");

/** The hosts named in `text`, normalized: lowercase, `\.` read as a dot, `\d+` as `*`. */
function hostsIn(text: string): Set<string> {
  const found = new Set<string>();
  const body = code(text);
  for (const re of PATTERNS) {
    for (const m of body.matchAll(re)) {
      const host = m[1]
        .replace(/\\d[+*]/g, "*")
        .replace(/\\\./g, ".")
        .toLowerCase();
      if (HOST_SHAPE.test(host)) found.add(host);
    }
  }
  return found;
}

const root = join(import.meta.dirname, "..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.test\.ts$/.test(e.name) ? [] : [join(dir, e.name)],
  );
/** Each host found, with the files that name it. */
const found = new Map<string, string[]>();
for (const file of ["src", "scripts"].flatMap((d) => walk(join(root, d)))) {
  for (const host of hostsIn(readFileSync(file, "utf8")))
    found.set(host, [...(found.get(host) ?? []), relative(root, file).replaceAll("\\", "/")]);
}

describe("the egress scan", () => {
  it("finds hosts in URLs, template literals, bare names and regular expressions", () => {
    const sample = [
      "fetch(`https://api.example.org/v1/$" + "{id}`);",
      "const page = `http://127.0.0.1:$" + "{port}/s/`;",
      'const u = new URL("wss://Gateway.Example.NET:443/x");',
      'const HOSTS = new Set(["cdn.example.com", "ghcr.io/you/gork"]);',
      "const ext = /^images-ext-\\d+\\.example\\.net$/;",
      'throw new Error("must be an https:// URL"); // or https://...',
      "// see https://docs.example.dev/page",
      " * and https://jsdoc.example.dev too",
      'readFileSync("custom.md"); readFileSync("package.json");',
    ].join("\n");
    expect([...hostsIn(sample)].sort()).toEqual([
      "127.0.0.1",
      "api.example.org",
      "cdn.example.com",
      "gateway.example.net",
      "ghcr.io",
      "images-ext-*.example.net",
    ]);
  });

  it("finds the hosts the bot is known to use", () => {
    for (const host of ["api.cloudflare.com", "cdn.discordapp.com", "www.youtube.com"])
      expect(found.has(host), host).toBe(true);
  });
});

describe("hosts named in src/ and scripts/", () => {
  it("are all on the allowlist", () => {
    const unlisted = [...found]
      .filter(([host]) => !(host in HOSTS))
      .map(([host, files]) => `${host} (${files.join(", ")})`);
    expect(
      unlisted,
      "a new host: add it to HOSTS in test/egress.test.ts with what it is for, and to docs/audit.md",
    ).toEqual([]);
  });

  it("are all still in use (no stale allowlist entries)", () => {
    const stale = Object.keys(HOSTS).filter((host) => !found.has(host));
    expect(stale, "no longer named in the code: remove it from HOSTS here and from docs/audit.md").toEqual([]);
  });
});
