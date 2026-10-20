// The setup page's decisions (scripts/lib/setup-page-logic.js), tested on their own, mostly on views a real setup
// session hands the page.
import { describe, expect, it } from "vitest";
import {
  advancedChanged,
  cardState,
  codeParts,
  finishLines,
  nameHint,
  pollKind,
  safeHref,
  secretHint,
} from "../scripts/lib/setup-page-logic.js";
import { json } from "./helpers.ts";
import { CHOICES, harness, toCloudflare, toGateway, whole } from "./setup-harness.ts";
import { DISCORD, refused } from "./setup-world.ts";

const fresh = () => harness().session.view();

describe("links", () => {
  it("only an https address becomes a link", () => {
    expect(safeHref("https://dash.cloudflare.com/x")).toBe("https://dash.cloudflare.com/x");
    for (const bad of ["http://example.com", "javascript:alert(1)", "//evil.example", " https://x", "", null, 5]) {
      expect(safeHref(bad), String(bad)).toBeNull();
    }
  });
});

describe("commands in a message", () => {
  it("splits out each backticked span as code", () => {
    expect(codeParts("Run `npm run logs` or `docker info`.")).toEqual([
      { text: "Run ", code: false },
      { text: "npm run logs", code: true },
      { text: " or ", code: false },
      { text: "docker info", code: true },
      { text: ".", code: false },
    ]);
  });

  it("leaves text with no pair of backticks as it is", () => {
    expect(codeParts("plain")).toEqual([{ text: "plain", code: false }]);
    expect(codeParts("a ` b")).toEqual([{ text: "a ` b", code: false }]);
  });
});

describe("pasted secrets, checked as they are typed", () => {
  const discord = `${"a".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`;

  it("says a Discord bot token looks right (with any middle part of six or more), and explains one with a space or the wrong shape", () => {
    expect(secretHint("discord", discord).level).toBe("ok");
    expect(secretHint("discord", `  ${discord}\n`).level).toBe("ok");
    expect(secretHint("discord", `${"a".repeat(24)}.${"b".repeat(9)}.${"c".repeat(27)}`).level).toBe("ok");
    expect(secretHint("discord", "abc def").text).toMatch(/space or line break/);
    expect(secretHint("discord", "just-some-text").text).toMatch(/two dots/);
  });

  it("says a Cloudflare token looks right, and spots a Discord token pasted in its box", () => {
    expect(secretHint("cloudflare", "A".repeat(40)).level).toBe("ok");
    expect(secretHint("cloudflare", discord).text).toMatch(/looks like a Discord token/);
    expect(secretHint("cloudflare", "short").text).toMatch(/too short/);
    expect(secretHint("cloudflare", "a b").text).toMatch(/space or line break/);
  });
});

describe("the Advanced answers in step 1", () => {
  const saved = async (over: Partial<typeof CHOICES>) => {
    const h = harness();
    return (await h.s.saveChoices({ ...CHOICES, budget: "0.50", ...over })).choices as NonNullable<
      ReturnType<typeof h.session.view>["choices"]
    >;
  };

  it("count as unchanged at the defaults", async () => {
    expect(advancedChanged(await saved({}), "UTC")).toBe(false);
    expect(advancedChanged(await saved({ billing: "free", budget: "3" }), "UTC")).toBe(false);
  });

  it("count as changed when any of them differs", async () => {
    expect(advancedChanged(await saved({ persona: "witty" }), "UTC")).toBe(true);
    expect(advancedChanged(await saved({ mentions: "reply" }), "UTC")).toBe(true);
    expect(advancedChanged(await saved({ timezone: "Europe/Paris" }), "UTC")).toBe(true);
    expect(advancedChanged(await saved({ budget: "2" }), "UTC")).toBe(true);
  });
});

describe("the custom personality's name", () => {
  it("accepts a name in any script that starts with a letter or number, and explains anything else", () => {
    for (const ok of ["", "gork", "Grōk 2", "グ", "o'brien-bot"]) expect(nameHint(ok).level, ok).toBe("");
    for (const bad of ["-gork", "gork!", "<b>"])
      expect(nameHint(bad), bad).toEqual({ level: "bad", text: expect.any(String) });
  });
});

describe("how often the page asks the server", () => {
  it("knocks on a lost server even before the first answer, and stops once stopped", () => {
    expect(pollKind(null, { lost: true })).toMatchObject({ path: "state" });
    expect(pollKind(fresh(), { lost: true, stopped: true })).toBeNull();
    expect(pollKind(null, {})).toBeNull();
  });

  it("asks for what the moment needs: state while something works, Discord while it waits for the bot, credits until they arrive or the person carries on, state otherwise", async () => {
    const v = fresh();
    expect(pollKind(v, {})).toMatchObject({ path: "state" });
    expect(pollKind(v, { pending: "discord" })).toMatchObject({ path: "state" });
    expect(pollKind({ ...v, work: { id: "cloudflare", steps: [] } }, {})).toMatchObject({ path: "state" });
    expect(pollKind({ ...v, start: { ...v.start, status: "running" } }, {})).toMatchObject({ path: "state" });

    const h = harness();
    await h.s.saveChoices({ ...CHOICES });
    const waiting = await h.s.discordToken(DISCORD);
    expect(pollKind(waiting, {})).toMatchObject({ path: "discord/refresh" });
    expect(pollKind({ ...waiting, discord: { ...waiting.discord, problem: "busy" } }, {})).toMatchObject({
      path: "discord/refresh",
    });
    expect(pollKind({ ...waiting, discord: { ...waiting.discord, publicBot: "on" } }, {})).toMatchObject({
      path: "discord/refresh",
    });
    // Discord won't list servers: asking again is pointless, the person pastes an ID.
    expect(pollKind({ ...waiting, discord: { ...waiting.discord, guildsProblem: "no" } }, {})).toMatchObject({
      path: "state",
    });

    const credits = await toGateway(harness({ chat: () => refused(402) }));
    expect(credits.cloudflare.needsCredits).toBe(true);
    expect(pollKind(credits, {})).toMatchObject({ path: "cloudflare/credits" });
    expect(pollKind(credits, { acked: true })).toMatchObject({ path: "state" });
  });
});

describe("which card is active", () => {
  it("follows the steps as a session does them, and locks everything after the choices while they are being changed", async () => {
    const h = harness();
    expect(cardState(h.session.view(), {})).toEqual({
      choices: "active",
      discord: "locked",
      cloudflare: "locked",
      finish: "locked",
    });
    await toCloudflare(h);
    expect(cardState(h.session.view(), {})).toMatchObject({ choices: "done", discord: "done", cloudflare: "active" });
    expect(cardState(h.session.view(), { editingChoices: true })).toEqual({
      choices: "active",
      discord: "locked",
      cloudflare: "locked",
      finish: "locked",
    });
    await h.s.cloudflareToken("BOOTSTRAP-SECRET-token", true);
    expect(cardState(h.session.view(), {})).toMatchObject({ cloudflare: "done", finish: "active" });
  });

  it("keeps Cloudflare open after a check that didn't pass, until Continue is pressed", async () => {
    const v = await toGateway(harness({ chat: () => refused(403) }));
    expect(cardState(v, {}).cloudflare).toBe("active");
    expect(cardState(v, { acked: true }).cloudflare).toBe("done");
  });
});

describe("the list at the end", () => {
  it("says what setup did, with nothing to worry about on a clean run", async () => {
    const lines = finishLines(await whole(harness()));
    expect(lines.map((l) => l.ok && !l.warn)).toEqual([true, true]);
    expect(lines[0].text).toMatch(/Only your account can read it/);
    expect(lines[1].text).toMatch(/setup token is deleted/);
  });

  it("says when there are no AI Gateway credits yet, with where to add them", async () => {
    const noCredits = () => json({ success: false, errors: [{ message: "insufficient credit balance" }] }, 402);
    const lines = finishLines(await whole(harness({ chat: noCredits })));
    expect(lines).toContainEqual({ ok: false, text: expect.stringMatching(/no AI Gateway credits.*ai-gateway/) });
  });

  it("flags what still needs attention: file permissions, the setup token, old keys, failed checks", async () => {
    const h = harness(
      {
        chat: () => refused(403),
        deleteBootstrapStatus: 403,
        existingTokens: [{ id: "old1", name: "gork-run" }],
        deleteStatus: { old1: 403 },
      },
      { host: { platform: "win32", runCommand: () => ({ ok: false }) } },
    );
    const text = finishLines(await whole(h)).map((l) => `${l.ok && !l.warn ? "ok" : "!"} ${l.text}`);
    expect(text[0]).toMatch(/^! .*couldn't restrict who can read it/);
    expect(text).toContainEqual(
      expect.stringMatching(/^! Setup couldn't confirm the setup token is gone.*dash\.cloudflare\.com/),
    );
    expect(text).toContainEqual(expect.stringMatching(/^! Revoked 0 older gork keys\./));
    expect(text).toContainEqual(expect.stringMatching(/^! Still there: "gork-run"/));
    expect(text).toContainEqual(expect.stringMatching(/^! chat: /));
  });
});
