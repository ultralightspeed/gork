// Step 1 of setup: the answers (billing, personality, pings, time zone, budget), and the custom personality, which is
// the one thing setup writes before the end.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "../../src/config.ts";
import { MENTION_KINDS, parseMentions } from "../../src/mentions.ts";
import { CUSTOM_FILE, type CustomDraft, renderCustom, validateCustom, writeCustomFile } from "./custom-persona.ts";
import { CliError } from "./errors.ts";
import type { SessionCore } from "./setup-core.ts";
import { type ChoicesInput, text, type View } from "./setup-state.ts";

export async function saveChoices(core: SessionCore, input: ChoicesInput): Promise<View> {
  if (existsSync(core.deps.envPath)) {
    throw new CliError(
      `${core.envName} already exists, and setup never overwrites it. Move it aside (for example rename it to ${core.envName}.old) and run setup again, or run \`npm run doctor\` to check the one you have.`,
    );
  }
  if (core.cf.token) {
    throw new CliError("Your answers are locked: Cloudflare setup has already started with them.");
  }
  const billing = text(input.billing);
  if (billing !== "credits" && billing !== "free") {
    throw new CliError("Choose how gork should pay for the AI model: credits or free.");
  }
  const persona = text(input.persona);
  if (persona === null || !core.personas.some((p) => p.name === persona)) {
    throw new CliError("Choose a personality from the list.");
  }
  const mentionsRaw = text(input.mentions);
  let kinds: ReturnType<typeof parseMentions>;
  try {
    kinds = parseMentions(mentionsRaw ?? "");
  } catch (err) {
    throw new CliError(`Who gork may ping: ${(err as Error).message}`);
  }
  const mentions =
    kinds.size === 0
      ? "none"
      : kinds.size === MENTION_KINDS.length
        ? "all"
        : MENTION_KINDS.filter((k) => kinds.has(k)).join(",");
  const zone = text(input.timezone) || SETTINGS.TIMEZONE.default;
  try {
    SETTINGS.TIMEZONE.parse(zone);
  } catch (err) {
    throw new CliError(`Time zone: ${(err as Error).message}`);
  }
  let budget: string = SETTINGS.DAILY_BUDGET_USD.default;
  if (billing === "credits") {
    budget = text(input.budget) || budget;
    try {
      SETTINGS.DAILY_BUDGET_USD.parse(budget);
    } catch (err) {
      throw new CliError(`Daily budget: ${(err as Error).message}`);
    }
  }
  // The custom personality is the one answer that is written to disk. Everything is checked before it is.
  let custom: { draft: CustomDraft; warnings: string[] } | null = null;
  if (persona === "custom") {
    const own = existsSync(join(core.deps.personasDir, CUSTOM_FILE));
    if (input.custom === undefined || input.custom === null) {
      if (!own) throw new CliError("Write your custom personality first: a name, and how gork should talk.");
    } else {
      custom = validateCustom(input.custom);
      const left = core.placeholders.filter((p) => custom?.draft.body.includes(p));
      if (left.length) {
        throw new CliError(
          `"How should gork talk and behave?" still has parts of the example to replace with your own words, such as ${left[0]}`,
        );
      }
    }
  }
  if (custom) {
    writeCustomFile(core.deps.personasDir, renderCustom(custom.draft));
    core.customDraft = custom.draft;
  }
  core.customWarnings = custom?.warnings ?? [];
  core.choices = {
    billing,
    persona,
    mentions,
    mentionsEveryone: kinds.has("everyone"),
    timezone: zone,
    budget,
  };
  return core.view();
}
