import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderEnvExample } from "../scripts/env-example.ts";
import { SETTING_KEYS, SETTINGS } from "../src/config.ts";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** The entries of compose.yaml's `environment:` block: key to the expression it passes through. */
function composeEnvironment(): Record<string, string> {
  const block =
    read("compose.yaml")
      .split(/^ {4}environment:\n/m)[1]
      ?.split(/^ {4}\S/m)[0] ?? "";
  const entries = [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*): (.*)$/gm)];
  return Object.fromEntries(entries.map((m) => [m[1], m[2]]));
}

describe("the settings table, .env.example and compose.yaml agree", () => {
  it(".env.example is exactly what the table renders (regenerate with: node scripts/env-example.ts)", () => {
    expect(read(".env.example")).toBe(renderEnvExample());
  });

  it("compose passes every setting the container reads, and only those", () => {
    const forContainer = SETTING_KEYS.filter((k) => !SETTINGS[k].scope);
    expect(Object.keys(composeEnvironment()).sort()).toEqual([...forContainer].sort());
  });

  it("passes each key through from its own name, blank meaning the code default", () => {
    for (const [key, expr] of Object.entries(composeEnvironment()))
      expect(expr, key).toBe(SETTINGS[key as keyof typeof SETTINGS].required ? `\${${key}}` : `\${${key}:-}`);
  });

  it("keeps the host-only admin token out of the container, and leaves DATA_DIR to the image", () => {
    const keys = Object.keys(composeEnvironment());
    expect(keys).not.toContain("CF_ADMIN_TOKEN");
    expect(keys).not.toContain("DATA_DIR");
    expect(read("Dockerfile")).toMatch(/^ENV .*\bDATA_DIR=\/data\b/m);
  });

  it("does not name the container, so a second checkout or a stray container called gork can't collide", () => {
    expect(read("compose.yaml")).not.toMatch(/^\s*container_name:/m);
  });
});
