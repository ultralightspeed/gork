// The setup page itself: one self-contained document that puts nothing from Discord or Cloudflare into the page as HTML,
// loads nothing from anywhere else, and keeps secrets out of the browser. Its decisions (what a secret looks like, how
// often to ask the server, what the end list says) are in setup-page-logic.js and tested in setup-page-logic.test.ts; these
// tests keep the document's structure and security properties. (It is also checked by hand in a real browser against
// the fake services.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { CUSTOM_LIMITS } from "../scripts/lib/custom-persona.ts";
import { IDLE_MS, startSetupServer, withPageLogic } from "../scripts/lib/setup-server.ts";
import { SetupSession } from "../scripts/lib/setup-session.ts";
import { tempDir } from "./helpers.ts";
import { CHOICES, harness, toGateway, whole } from "./setup-harness.ts";
import { DISCORD, PERSONAS, world } from "./setup-world.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../scripts/lib/setup-page.html");
const logic = read("../scripts/lib/setup-page-logic.js");
/** The page as the server sends it (before the nonce): the logic module is inside its one script. */
const page = withPageLogic(source);
const script = /<script nonce="\{\{NONCE\}\}">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
const markup = page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

const session = () =>
  new SetupSession({
    fetch: world({}).f,
    now: Date.now,
    envPath: join(tempDir("gork-page-"), ".env"),
    personasDir: PERSONAS,
    startBot: async () => "ready",
  });

describe("the page is one self-contained document", () => {
  it("has exactly one script and one style, both carrying the nonce, and no other way to run code", () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page.match(/<style\b/g)).toHaveLength(1);
    expect(page.match(/<script nonce="\{\{NONCE\}\}">/g)).toHaveLength(1);
    expect(page.match(/<style nonce="\{\{NONCE\}\}">/g)).toHaveLength(1);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
    expect(markup).not.toMatch(/javascript:/i);
    expect(page).not.toMatch(/<(iframe|object|embed|base|form\s[^>]*action)/i);
  });

  it("loads nothing from anywhere: no linked styles, scripts, images, fonts or imports", () => {
    expect(page).not.toMatch(/<link\b/i);
    expect(page).not.toMatch(/<(img|audio|video|source)\b/i);
    expect(page).not.toMatch(/\ssrc\s*=/i);
    expect(page).not.toMatch(/@import|url\(/i);
    expect(script).not.toMatch(/\b(import|importScripts|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
    // The only network call goes to the page's own api/ paths, relative to where the page is.
    const fetches = [...script.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
    expect(fetches).toEqual(['"api/" + path']);
  });

  it("starts every link at an https address that matches what the server says", () => {
    const server = session().view().links;
    const hrefs = Object.fromEntries(
      [...markup.matchAll(/<a\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(hrefs["open-discord"]).toBe(server.discordApp);
    expect(hrefs["cf-signup"]).toBe(server.cloudflareSignup);
    expect(hrefs["open-credits"]).toBe(server.credits);
    expect(hrefs["docker-link"]).toBe(server.docker);
    expect(hrefs["podman-link"]).toBe(server.podman);
    // These two are filled in by the server's own answer: the prefilled token form, and the invite for this bot.
    expect(server.cloudflareToken.startsWith(hrefs["open-cloudflare"])).toBe(true);
    for (const href of Object.values(hrefs)) expect(href.startsWith("https://")).toBe(true);
    expect(markup).not.toMatch(/\shref\s*=\s*["']?http:/i);
  });

  it("has every element the script looks up by id", () => {
    const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = new Set([...script.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]));
    expect(wanted.size).toBeGreaterThan(30);
    expect([...wanted].filter((id) => !ids.has(id))).toEqual([]);
    // Ids built from a prefix: the progress cards and the work checklists.
    for (const name of ["choices", "discord", "cloudflare", "finish"]) {
      expect(ids.has(`card-${name}`) && ids.has(`h-${name}`), name).toBe(true);
    }
    for (const id of ["discord", "cloudflare", "finish"]) {
      for (const part of ["", "-list", "-say"]) expect(ids.has(`work-${id}${part}`), `work-${id}${part}`).toBe(true);
    }
  });
});

describe("the page logic inside the script", () => {
  it("is the module itself, without its export words, where the page asked for it", () => {
    expect(source).toContain("/* {{PAGE_LOGIC}} */");
    expect(page).not.toContain("{{PAGE_LOGIC}}");
    expect(script).toContain(logic.replace(/^export /gm, ""));
    expect(script).not.toMatch(/^\s*export /m);
  });

  it("puts in code holding $ characters exactly as written", () => {
    expect(withPageLogic("a /* {{PAGE_LOGIC}} */ b", 'export const x = "$\' $& $1";')).toBe(
      'a const x = "$\' $& $1"; b',
    );
  });

  it("makes a script that is valid JavaScript, defining each function once", () => {
    expect(() => new Script(script, { filename: "setup-page.html" })).not.toThrow();
    for (const [, name] of logic.matchAll(/^export function (\w+)/gm)) {
      expect(script.match(new RegExp(`function ${name}\\b`, "g")), name).toHaveLength(1);
    }
  });

  it("is what the server sends, in a page that really has the nonce in it", async () => {
    const server = await startSetupServer({ session: session(), page: source });
    try {
      // The printed address swaps its token for a cookie and sends the browser on to the page.
      const opened = await fetch(server.url, { redirect: "manual" });
      const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
      const res = await fetch(new URL(opened.headers.get("location") ?? "", server.url), { headers: { cookie } });
      const body = await res.text();
      const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
      expect(res.status).toBe(200);
      expect(nonce).toBeTruthy();
      expect(body).toBe(page.replaceAll("{{NONCE}}", nonce as string));
    } finally {
      await server.close();
    }
  });
});

describe("the script, run against a stand-in for the browser", () => {
  /** Runs the page's script with elements that just keep what is set on them, and the server answering `view`. */
  async function runPage(view: unknown) {
    const elements = new Map<string, Record<string, unknown>>();
    const element = (tagName = ""): Record<string, unknown> => {
      const kept: Record<string, unknown> = { tagName, dataset: {}, value: "", textContent: "", hidden: false };
      kept.replaceChildren = (...kids: unknown[]) => {
        kept.children = kids;
        kept.textContent = kids
          .map((k) => (typeof k === "string" ? k : (k as { textContent: string }).textContent))
          .join("");
      };
      kept.append = (...kids: unknown[]) => {
        kept.children = [...((kept.children as unknown[]) ?? []), ...kids];
      };
      kept.setAttribute = (name: string, value: string) => {
        kept[`@${name}`] = value;
      };
      return new Proxy(kept, {
        get: (t, p: string) =>
          p in t
            ? t[p]
            : p === "querySelector"
              ? () => element()
              : p === "getAttribute"
                ? () => null
                : p === "hasAttribute"
                  ? () => false
                  : () => undefined,
      });
    };
    const byId = (id: string) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    };
    const asked: string[] = [];
    const sandbox = {
      document: {
        getElementById: byId,
        // Nothing is ticked; anything else (a progress dot) is there.
        querySelector: (selector: string) => (selector.includes(":checked") ? null : element()),
        querySelectorAll: () => [],
        createElement: (tag: string) => element(tag),
        createTextNode: (t: string) => t,
        addEventListener: () => {},
        hidden: false,
      },
      matchMedia: () => ({ matches: false }),
      Intl,
      setTimeout: () => 0,
      clearTimeout: () => {},
      fetch: async (path: string) => {
        asked.push(path);
        return new Response(JSON.stringify({ ok: true, view }), { status: 200 });
      },
    };
    new Script(script).runInNewContext(sandbox);
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    return { byId, asked };
  }

  it("asks for the state and draws the first card, with the rest locked", async () => {
    const p = await runPage(session().view());
    expect(p.asked).toEqual(["api/state"]);
    expect(p.byId("card-choices")?.dataset).toEqual({ state: "active" });
    expect(p.byId("card-discord")?.dataset).toEqual({ state: "locked" });
    expect(p.byId("env-name")?.textContent).toBe(".env");
  });

  it("draws the end of a whole setup, with its list and what to do next", async () => {
    const h = harness();
    const v = await whole(h);
    const p = await runPage(v);
    expect(p.byId("card-finish")?.dataset).toEqual({ state: "active" });
    expect(p.byId("f-after")?.hidden).toBe(false);
    expect(p.byId("f-start")?.hidden).toBe(false);
    expect(p.byId("cloudflare-summary")?.textContent).toMatch(/made and tested/);
  });

  it("offers the invite while the bot is still public, with the private step folded beside it", async () => {
    const h = harness({ app: { bot_public: true } });
    await h.s.saveChoices({ ...CHOICES });
    const p = await runPage(await h.s.discordToken(DISCORD));
    expect(p.byId("d-invite")?.hidden).toBe(false);
    expect(p.byId("d-public")?.hidden).toBe(false);
  });

  it("marks a done step with a catch as a warning, and what still needs doing as a problem", async () => {
    const h = harness(
      { deleteBootstrapStatus: 403 },
      { host: { platform: "win32", runCommand: () => ({ ok: false }) } },
    );
    const p = await runPage(await whole(h));
    const marks = ((p.byId("finish-list")?.children ?? []) as Record<string, unknown>[]).map(
      (li) => (li.children as Record<string, unknown>[])[0]?.["@class"],
    );
    // .env saved but readable by others; the setup token not confirmed gone.
    expect(marks.slice(0, 2)).toEqual(["mark warn", "mark bad"]);
  });

  it("colours problems with --bad and warnings with --warn", () => {
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
    expect(style).toMatch(/\.hint\[data-level="bad"\] \{ color: var\(--bad\); \}/);
    expect(style).toMatch(/\.checks \.bad \{ color: var\(--bad\); \}/);
    expect(style).toMatch(/\.checks \.warn \{ color: var\(--warn\); \}/);
  });

  it("shows a command in a message as code, without its backticks", async () => {
    const v = await whole(harness());
    const message = "Something went wrong. Run `npm run logs` to see.";
    const p = await runPage({ ...v, start: { ...v.start, status: "failed", message } });
    const box = p.byId("start-error") ?? {};
    expect(box.textContent).toBe("Something went wrong. Run npm run logs to see.");
    const code = ((box.children ?? []) as Record<string, unknown>[]).find((k) => typeof k === "object");
    expect(code).toMatchObject({ tagName: "code", textContent: "npm run logs" });
  });

  it("draws the question about a gateway already in the way, with the preview of a new name", async () => {
    const h = harness({ gateways: { gork: { id: "gork" } } });
    const v = await toGateway(h);
    const p = await runPage(v);
    expect(p.byId("c-gateway")?.hidden).toBe(false);
    expect(p.byId("btn-gw-suggest")?.textContent).toBe("Use gork-2");
    expect(p.byId("btn-gw-new")?.disabled).toBe(true);
  });
});

describe("nothing outside the page is ever put in as HTML", () => {
  it("never uses an HTML-parsing sink, or eval", () => {
    for (const sink of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "createContextualFragment",
      "DOMParser",
      "srcdoc",
      "eval(",
      "new Function",
      "Function(",
      'setTimeout("',
      'setInterval("',
      "location.href",
      "location =",
      "window.open",
    ]) {
      expect(script, sink).not.toContain(sink);
    }
  });

  it("sets an href in one place only (the link helper, which takes only what safeHref allows)", () => {
    expect([...script.matchAll(/setAttribute\("href"/g)]).toHaveLength(1);
  });

  it("opens every link to another site in a new tab without handing that site this address", () => {
    const links = [...markup.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThan(5);
    for (const a of links) {
      expect(a, a).toMatch(/target="_blank"/);
      expect(a, a).toMatch(/rel="noopener noreferrer"/);
    }
    expect(page).toMatch(/<meta name="referrer" content="no-referrer">/);
  });
});

describe("secrets in the page", () => {
  it("are typed into password fields", () => {
    for (const id of ["discord-token", "cf-token"]) {
      const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(markup)?.[0] ?? "";
      expect(tag, id).toMatch(/type="password"/);
    }
  });

  it("are never stored in the browser or written to its console", () => {
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(script).not.toMatch(/console\.(log|info|debug|warn|error)/);
  });

  it("are sent only to the two routes that take them", () => {
    const uses = [...script.matchAll(/call\("([\w/-]+)", \{[^}]*token/g)].map((m) => m[1]);
    expect(uses.sort()).toEqual(["cloudflare/token", "discord/token"]);
  });
});

describe("what the page says that has to match the code", () => {
  it("names the server's own idle time", () => {
    const minutes = Number(/sat unused for (\d+) minutes/.exec(markup)?.[1]);
    expect(minutes * 60_000).toBe(IDLE_MS);
  });

  it("says how long things take once each: setup, the quick download, the slow local build", () => {
    const text = markup.replace(/<[^>]+>/g, " ");
    expect(text.match(/about 10 minutes/g)).toHaveLength(1);
    expect(text.match(/15 to 30 minutes/g)).toHaveLength(1);
    expect(text).toMatch(/downloads gork's image, which is quick/);
    expect(text).not.toMatch(/a few minutes/);
  });

  it("warns, before it lets you choose free mode, that it is only free on the Workers Free plan", () => {
    expect(markup).toMatch(/only free on the Workers Free plan/i);
    expect(markup).toMatch(/Workers Paid/);
  });

  it("limits the custom personality's boxes to the lengths the server accepts", () => {
    const max = (id: string) =>
      Number(new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*maxlength="(\\d+)"`).exec(markup)?.[1]);
    expect(max("custom-name")).toBe(CUSTOM_LIMITS.name);
    expect(max("custom-body")).toBe(CUSTOM_LIMITS.body);
    expect(max("custom-quirk")).toBe(CUSTOM_LIMITS.quirk);
  });
});

describe("step 1's layout", () => {
  const form = /<form[^>]*id="choices-form"[^>]*>([\s\S]*?)<\/form>/.exec(markup)?.[1] ?? "";
  const advanced =
    /<details id="advanced"[^>]*>([\s\S]*?)<\/details>\s*<p class="error" id="err-choices"/.exec(form)?.[1] ?? "";

  it("asks about billing up front and folds the rest under Advanced, closed", () => {
    expect(form.indexOf('name="billing"')).toBeLessThan(form.indexOf('<details id="advanced"'));
    expect(advanced).not.toContain('name="billing"');
    for (const id of ['id="persona-list"', 'name="pings"', 'id="timezone"', 'id="budget"'])
      expect(advanced).toContain(id);
    expect(form).not.toMatch(/<details id="advanced"[^>]*\sopen/);
  });

  it("keeps the jargon behind a More disclosure, with one plain line per choice in front", () => {
    const more = [...markup.matchAll(/<details class="more">([\s\S]*?)<\/details>/g)].map((m) => m[1]).join("\n");
    const front = markup.replace(/<details class="more">[\s\S]*?<\/details>/g, "");
    for (const term of [/neurons/, /\$0\.011/, /zero data retention/, /start-up command|second key/]) {
      expect(front).not.toMatch(term);
    }
    for (const term of [/neurons/, /\$0\.011/, /zero data retention/, /CF_ADMIN_TOKEN/]) expect(more).toMatch(term);
  });

  it("starts Advanced at the defaults: no pings, a budget of $0.50", () => {
    expect(advanced).toMatch(/<input type="radio" name="pings" value="none" checked>/);
    expect(advanced).toMatch(/<input[^>]*id="budget"[^>]*value="0\.50"/);
  });
});

describe("how the page speaks", () => {
  /** The page's visible text: the markup without tags. */
  const words = markup.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
  /** Every string literal in a script, comments left out. */
  const literals = (code: string) =>
    code.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "").match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  // Everything here can reach the page: its own text, and the messages the session sends it.
  const SERVER = [
    "setup-core",
    "setup-step-choices",
    "setup-step-discord",
    "setup-step-cloudflare",
    "setup-step-finish",
    "setup-cleanup",
    "setup-view",
    "discord-setup",
    "cloudflare-setup",
    "setup-state",
    "custom-persona",
    "compose",
    "engine",
    "gateway",
    "env-file",
    "image",
  ].map((m) => read(`../scripts/lib/${m}.ts`));
  // @me is part of Discord's API paths.
  const FIRST_PERSON = /(?<!@)\b(I|I'll|I'm|I've|I'd|me|my)\b/;

  it("never says I, me or my", () => {
    expect(words).not.toMatch(FIRST_PERSON);
    for (const s of literals(script)) expect(s).not.toMatch(FIRST_PERSON);
    for (const s of SERVER.flatMap(literals)) expect(s).not.toMatch(FIRST_PERSON);
  });

  it("shows no Markdown backticks of its own: commands are in <code>", () => {
    expect(words).not.toContain("`");
    for (const s of literals(script).filter((l) => l.startsWith('"'))) expect(s).not.toContain("`");
    expect(markup).toMatch(/<code>npm run setup<\/code>/);
  });

  it("says the tokens go only to Discord, Cloudflare and .env", () => {
    expect(words).not.toMatch(/everything (on this page )?stays on (this|your) computer/i);
    expect(words).toMatch(/only to Discord and Cloudflare, and into .env on this computer/);
  });
});
