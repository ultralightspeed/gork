import { describe, expect, it } from "vitest";
import { CfError } from "../src/cf.ts";
import { describeError, isFatalCloseCode, isFatalLoginError } from "../src/errors.ts";

describe("describeError", () => {
  it("includes the Discord error code, so 'Missing Permissions' isn't just 'DiscordAPIError'", () => {
    const err = Object.assign(new Error("Missing Permissions"), { name: "DiscordAPIError[50013]", code: 50013 });
    expect(describeError(err)).toBe("DiscordAPIError[50013] (code 50013): Missing Permissions");
  });

  it("includes the HTTP status for Cloudflare errors", () => {
    expect(describeError(new CfError(403, '{"errors":[{"code":10000,"message":"Authentication error"}]}'))).toMatch(
      /^Error \(HTTP 403\): Cloudflare HTTP 403: .*Authentication error/,
    );
  });

  it("caps long messages and copes with non-errors", () => {
    expect(describeError(new Error("x".repeat(500))).length).toBeLessThanOrEqual(220);
    expect(describeError("boom")).toBe("boom");
  });
});

describe("fatal Discord errors (restarting would only burn the daily login limit)", () => {
  it("recognises an invalid token or disallowed intents at login", () => {
    expect(
      isFatalLoginError(Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" })),
    ).toBe(true);
    expect(isFatalLoginError(Object.assign(new Error("Used disallowed intents"), { code: "DisallowedIntents" }))).toBe(
      true,
    );
    expect(isFatalLoginError(new Error("getaddrinfo ENOTFOUND discord.com"))).toBe(false);
  });

  it("recognises gateway close codes discord.js won't reconnect from", () => {
    for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) expect(isFatalCloseCode(code)).toBe(true);
    for (const code of [1000, 1006, 4000, 4009]) expect(isFatalCloseCode(code)).toBe(false);
  });
});
