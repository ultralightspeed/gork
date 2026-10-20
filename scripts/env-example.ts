// Renders .env files from the settings table in src/config.ts. Run `node scripts/env-example.ts` to write
// .env.example; test/env-sync.test.ts fails when the committed file differs from this output.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GROUPS, SETTING_KEYS, SETTINGS, type SettingKey } from "../src/config.ts";

const EXAMPLE_HEADER = [
  "# gork settings. Copy to .env and fill in the required ones; the rest are defaults you can tune later.",
  "# Comments must be on their own lines, and values are not quoted.",
];

/**
 * Renders every setting with its help line, as a .env file: `values` for the keys given, defaults for the rest.
 * .env.example is renderEnv({}); `gork setup` writes the same layout with the answers filled in.
 */
export function renderEnv(values: Partial<Record<SettingKey, string>>, header: string[] = EXAMPLE_HEADER): string {
  const lines = [...header];
  for (const group of GROUPS) {
    lines.push("", `# ===== ${group} =====`);
    for (const key of SETTING_KEYS) {
      const s = SETTINGS[key];
      if (s.group !== group || s.scope === "image") continue;
      const value = values[key] ?? s.default;
      // A newline would start another setting; refuse rather than write a file that says something else.
      if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line`);
      lines.push(`# ${s.required ? "Required. " : ""}${s.help}`, `${key}=${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export const renderEnvExample = (): string => renderEnv({});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeFileSync(new URL("../.env.example", import.meta.url), renderEnvExample());
  console.log("wrote .env.example");
}
