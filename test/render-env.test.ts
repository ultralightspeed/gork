import { describe, expect, it } from "vitest";
import { renderEnv } from "../scripts/env-example.ts";
import { loadConfig } from "../src/config.ts";

// With no values, renderEnv is the committed .env.example; test/env-sync.test.ts pins that layout.
describe("renderEnv", () => {
  it("fills the given keys and leaves every other key at its default", () => {
    const text = renderEnv({ DISCORD_TOKEN: "tok", GUILD_IDS: "1,2", BILLING_MODE: "free" });
    expect(text).toMatch(/^DISCORD_TOKEN=tok$/m);
    expect(text).toMatch(/^GUILD_IDS=1,2$/m);
    expect(text).toMatch(/^BILLING_MODE=free$/m);
    expect(text).toMatch(/^CF_RUN_TOKEN=$/m);
  });

  it("takes a custom header and uses LF line endings only", () => {
    const text = renderEnv({}, ["# written by setup", "# second line"]);
    expect(text.startsWith("# written by setup\n# second line\n")).toBe(true);
    expect(text).not.toContain("\r");
  });

  it("refuses a value that could start another line (a pasted token with a newline)", () => {
    expect(() => renderEnv({ DISCORD_TOKEN: "abc\nCF_ADMIN_TOKEN=evil" })).toThrow(/DISCORD_TOKEN/);
    expect(() => renderEnv({ DISCORD_TOKEN: "abc\rdef" })).toThrow(/DISCORD_TOKEN/);
  });

  it("produces a file loadConfig accepts once the required keys are set", () => {
    const text = renderEnv({
      DISCORD_TOKEN: "d",
      GUILD_IDS: "1",
      CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CF_RUN_TOKEN: "r",
      CF_ADMIN_TOKEN: "x",
      BILLING_MODE: "free",
    });
    const env = Object.fromEntries([...text.matchAll(/^([A-Z_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    expect(loadConfig(env).billing).toBe("free");
  });
});
