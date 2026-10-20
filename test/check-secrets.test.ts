import { describe, expect, it } from "vitest";
import { findProblems, secretKeys } from "../scripts/check-secrets.ts";
import { SETTINGS } from "../src/config.ts";

const fakeTable = {
  PLAIN_SETTING: { group: "Limits", default: "1", help: "", parse: String },
  NEW_VENDOR_KEY: { group: "Model", default: "", secret: true, help: "", parse: String },
} as const;

describe("which keys are secrets", () => {
  it("is exactly the rows flagged secret: true, so a new secret row is guarded with no script edit", () => {
    const keys = secretKeys(fakeTable);
    expect(keys).toEqual(["NEW_VENDOR_KEY"]);
    const problems = (text: string) => findProblems([{ path: ".env.example", text }], keys);
    expect(problems("NEW_VENDOR_KEY=sk-live-123\n")).toEqual([".env.example: a secret variable has a value"]);
    expect(problems("NEW_VENDOR_KEY=\n# NEW_VENDOR_KEY=abc\nPLAIN_SETTING=5\n")).toEqual([]);
  });

  it("includes every secret in the real table, and each is flagged with a value but not when blank", () => {
    const keys = secretKeys(SETTINGS);
    expect(keys).toEqual(expect.arrayContaining(["DISCORD_TOKEN", "CF_RUN_TOKEN", "CF_ADMIN_TOKEN", "LLM_API_KEY"]));
    expect(keys).not.toContain("GUILD_IDS");
    const scan = (text: string) => findProblems([{ path: ".env.example", text }], keys);
    for (const key of keys) expect(scan(`${key}=abc\n`), key).toHaveLength(1);
    expect(scan(keys.map((key) => `${key}=\n`).join(""))).toEqual([]);
  });
});

describe("what check-secrets flags in tracked files", () => {
  const keys = secretKeys(SETTINGS);
  const scan = (path: string, text: string) => findProblems([{ path, text }], keys);
  const cfToken = "Ab1_".repeat(10);
  const apiKey = `sk-${"Zq9-".repeat(10)}`;

  it("flags env files and temp files, but allows .env.example", () => {
    const files = [".env", "config/.env", ".env.local", ".env.example", "notes.tmp", "tmp/readme.md"].map((path) => ({
      path,
      text: "",
    }));
    expect(findProblems(files, keys)).toEqual([
      ".env: env file is tracked",
      "config/.env: env file is tracked",
      ".env.local: env file is tracked",
      "notes.tmp: temp file is tracked",
    ]);
  });

  it("flags Discord-token-shaped strings (a middle part of six or more, as the setup page accepts), but not one inside a longer word", () => {
    const token = (first: string, middle: number) =>
      `${first}${"a".repeat(23)}.${"b".repeat(middle)}.${"c".repeat(27)}`;
    expect(scan("src/x.ts", `const t = "${token("M", 6)}";`)).toEqual(["src/x.ts: Discord-token-shaped string"]);
    expect(scan("src/x.ts", `"${token("N", 9)}"`)).toEqual(["src/x.ts: Discord-token-shaped string"]);
    // The setup tests' fake tokens have a longer word in front of what would otherwise look like one.
    expect(scan("test/x.ts", `"X${token("M", 7)}"`)).toEqual([]);
  });

  it("flags a secret key assigned a value in any tracked file, such as a code block in the docs, but allows blanks and placeholders", () => {
    expect(scan("docs/setup.md", "```\nDISCORD_TOKEN=abc\n```\n")).toEqual([
      "docs/setup.md: a secret variable has a value",
    ]);
    expect(scan("compose.yaml", "  CF_RUN_TOKEN = abc\n")).toEqual(["compose.yaml: a secret variable has a value"]);
    const dollar = "$";
    for (const value of ["", "<your token>", "...", `${dollar}{DISCORD_TOKEN}`, `${dollar}DISCORD_TOKEN`, "xxxx"]) {
      expect(scan("docs/setup.md", `DISCORD_TOKEN=${value}\n`), value).toEqual([]);
    }
  });

  it("flags a 40-character Cloudflare-token-shaped value next to a CF_*TOKEN name, but not a hash or id elsewhere", () => {
    expect(scan("src/x.ts", `const env = { CF_ADMIN_TOKEN: "${cfToken}" };`)).toEqual([
      "src/x.ts: Cloudflare-token-shaped string",
    ]);
    expect(scan("package-lock.json", `"integrity": "${"f".repeat(40)}"`)).toEqual([]);
    expect(scan("src/x.ts", `const CF_RUN_TOKEN_HELP = "see the docs"; const sha = "${"a1".repeat(20)}";`)).toEqual([]);
  });

  it("flags an sk- style API key, but not a short made-up one in a test", () => {
    expect(scan("src/x.ts", `const key = "${apiKey}";`)).toEqual(["src/x.ts: API-key-shaped string"]);
    expect(scan("test/x.test.ts", 'const SECRET = "sk-live-SUPERSECRETVALUE.x";')).toEqual([]);
  });
});
