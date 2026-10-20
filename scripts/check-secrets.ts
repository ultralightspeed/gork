// Fails if a tracked file looks like it contains a secret. Run before every push: npm run check-secrets
// The secret variable names come from the `secret: true` rows of the SETTINGS table in src/config.ts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SETTINGS } from "../src/config.ts";

interface ScannedFile {
  path: string;
  /** undefined when the file could not be read as text (binary or missing): it is skipped. */
  text: string | undefined;
}

/** A bot token: the same shape the setup page accepts (three dot-separated parts), not inside a longer word. */
const discordToken = /(?<![\w-])[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6,}\.[\w-]{27,}/;
/** A Cloudflare API token (40 characters) written right after a CF_..._TOKEN name, as in .env, YAML, JSON or code. */
const cloudflareToken = /\bCF_[A-Z_]*TOKEN\b["']?[ \t]*[:=][ \t]*["']?[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/;
/** An sk- style API key (OpenAI, Anthropic, OpenRouter and others use this prefix), long enough to be a real one. */
const apiKey = /(?<![\w-])sk-[A-Za-z0-9_-]{32,}/;
/** Values that only stand in for a secret: <your token>, ..., ${NAME} or $NAME, xxxx, ****. */
const placeholder = /^(<[^>]*>|\.{3}|…|\$\{?[A-Z_][A-Z0-9_]*\}?|x{3,}|X{3,}|\*{3,})$/;

/** The names of every setting flagged `secret: true`. */
export function secretKeys(settings: Record<string, object>): string[] {
  return Object.keys(settings).filter((key) => (settings[key] as { secret?: true }).secret === true);
}

/** True when some line sets one of `keys` to a real-looking value (not empty, a comment or a placeholder). */
function assignsSecret(text: string, keys: readonly string[]): boolean {
  if (!keys.length) return false;
  const assignment = new RegExp(String.raw`^[ \t]*(?:${keys.join("|")})[ \t]*=(.*)$`, "gm");
  for (const m of text.matchAll(assignment)) {
    const value = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value !== "" && !value.startsWith("#") && !placeholder.test(value)) return true;
  }
  return false;
}

export function findProblems(files: readonly ScannedFile[], keys: readonly string[]): string[] {
  const problems: string[] = [];
  for (const { path, text } of files) {
    if (/(^|\/)\.env$/.test(path) || (/(^|\/)\.env\./.test(path) && !path.endsWith(".env.example"))) {
      problems.push(`${path}: env file is tracked`);
      continue;
    }
    if (path.endsWith(".tmp")) {
      problems.push(`${path}: temp file is tracked`);
      continue;
    }
    if (text === undefined) continue;
    if (discordToken.test(text)) problems.push(`${path}: Discord-token-shaped string`);
    if (cloudflareToken.test(text)) problems.push(`${path}: Cloudflare-token-shaped string`);
    if (apiKey.test(text)) problems.push(`${path}: API-key-shaped string`);
    if (assignsSecret(text, keys)) problems.push(`${path}: a secret variable has a value`);
  }
  return problems;
}

function main() {
  const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const files = paths.map((path): ScannedFile => {
    try {
      return { path, text: readFileSync(path, "utf8") };
    } catch {
      return { path, text: undefined };
    }
  });
  const problems = findProblems(files, secretKeys(SETTINGS));
  if (problems.length) {
    console.error(`check-secrets: FAILED\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`check-secrets: ok (${files.length} tracked files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
