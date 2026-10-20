import { describe, expect, it } from "vitest";
import { planProbes, report, reportError, roundTripMessages, splitPng } from "../scripts/probe.ts";
import { CREDITS_MODEL, FREE_MODEL, SettingsError } from "../src/config.ts";

describe("planProbes", () => {
  it("credits mode (the default) goes through the gateway, with the credits model, and searches", () => {
    const p = planProbes({});
    expect(p.billing).toBe("credits");
    expect(p.model).toBe(CREDITS_MODEL);
    expect(p.chatHeaders).toEqual({ "cf-aig-gateway-id": "gork", "cf-aig-collect-log-payload": "false" });
    expect(p.webSearch).toBe(true);
    expect(p.searchProvider).toBe("ceramic");
  });

  it("uses AI_GATEWAY_ID, SEARCH_PROVIDER and LLM_MODEL when set", () => {
    const p = planProbes({ AI_GATEWAY_ID: "mine", SEARCH_PROVIDER: "exa", LLM_MODEL: "@cf/x/y" });
    expect(p.chatHeaders["cf-aig-gateway-id"]).toBe("mine");
    expect(p.searchProvider).toBe("exa");
    expect(p.model).toBe("@cf/x/y");
  });

  it("free mode sends no gateway header, uses the free model, and never searches", () => {
    const p = planProbes({ BILLING_MODE: "free", AI_GATEWAY_ID: "mine" });
    expect(p.billing).toBe("free");
    expect(p.model).toBe(FREE_MODEL);
    expect(Object.keys(p.chatHeaders)).toEqual([]);
    expect(p.webSearch).toBe(false);
  });

  it("treats blank values as unset, as the bot does", () => {
    const p = planProbes({ BILLING_MODE: "", LLM_MODEL: " ", AI_GATEWAY_ID: "" });
    expect(p.billing).toBe("credits");
    expect(p.model).toBe(CREDITS_MODEL);
    expect(p.chatHeaders["cf-aig-gateway-id"]).toBe("gork");
  });

  it("refuses an account id that isn't 32 hex characters, since it goes into the URL", () => {
    expect(() => planProbes({ CF_ACCOUNT_ID: "../../other" })).toThrow(/CF_ACCOUNT_ID/);
    expect(planProbes({ CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" }).accountId).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });

  it("refuses a bad BILLING_MODE rather than quietly probing the paid path", () => {
    expect(() => planProbes({ BILLING_MODE: "cheap" })).toThrow(SettingsError);
  });
});

describe("what a probe prints", () => {
  const TOKEN = "run-token-0123456789abcdef";

  it("takes a secret the API echoed out of the body", () => {
    const body = JSON.stringify({ errors: [{ message: `bad header: Bearer ${TOKEN}` }] });
    const out = report("chat", { status: 400, ok: false, text: body }, (j) => j, [TOKEN]);
    expect(out).toContain("== chat: HTTP 400");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(TOKEN);
  });

  it("takes a secret out of the shaped summary of a success", () => {
    const out = report("chat", { status: 200, ok: true, text: JSON.stringify({ a: TOKEN }) }, (j) => j.a, [TOKEN]);
    expect(out).not.toContain(TOKEN);
  });

  it("takes a secret out of a failed request's error message", () => {
    const out = reportError("chat", new Error(`connect failed for ${TOKEN}`), [TOKEN]);
    expect(out).toContain("== chat: ERROR");
    expect(out).not.toContain(TOKEN);
  });
});

describe("the tool round-trip probe", () => {
  const ask = { role: "user" as const, content: "q" };
  const call = { id: "c1", type: "function", function: { name: "look", arguments: "{}" } };

  it("makes a real PNG, so only a model that sees it can name its two colours", () => {
    const url = splitPng([0, 200, 0], [230, 0, 230]);
    expect(url).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(url.split(",")[1], "base64");
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(12, 16).toString()).toBe("IHDR");
  });

  it("sends what the bot sends: the call, its tool message right after, then the images in a user message", () => {
    const m = roundTripMessages(ask, call, splitPng([0, 200, 0], [230, 0, 230]));
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(m[2]).toMatchObject({ tool_call_id: "c1" });
    expect(JSON.stringify(m[3].content)).toContain("image_url");
  });

  it("leaves the image out for a model that can't see", () => {
    expect(roundTripMessages(ask, call, null).map((x) => x.role)).toEqual(["user", "assistant", "tool"]);
  });
});
