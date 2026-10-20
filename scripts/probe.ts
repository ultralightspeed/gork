// One-off live probe of every external API gork uses (npm run probe). Prints status codes, shapes and usage only:
// never headers, tokens, or signed caption URLs. Follows BILLING_MODE like the bot: in free mode it calls Workers AI
// directly (no gateway header, the free model) and skips the paid web search.
import { pathToFileURL } from "node:url";
import { withoutSecrets } from "../src/cf.ts";
import { CREDITS_MODEL, FREE_MODEL, readSettings, SettingsError } from "../src/config.ts";
import { YOUTUBE_CLIENT } from "../src/youtube.ts";

type Env = Record<string, string | undefined>;

interface ProbePlan {
  billing: "credits" | "free";
  accountId: string;
  model: string;
  gatewayId: string;
  searchProvider: string;
  /** The chat call's extra headers: the gateway ones in credits mode, none in free mode. */
  chatHeaders: Record<string, string>;
  /** Web search is paid and credits-only. */
  webSearch: boolean;
}

/** What to probe, from the same settings the bot reads. Throws SettingsError on a bad value. */
export function planProbes(env: Env): ProbePlan {
  // The account id goes into the URL path, so a set one is validated like the bot does (blank is main's problem).
  const keys = ["BILLING_MODE", "AI_GATEWAY_ID", "SEARCH_PROVIDER", "LLM_MODEL"] as const;
  const s = env.CF_ACCOUNT_ID?.trim()
    ? readSettings(env, [...keys, "CF_ACCOUNT_ID"])
    : { ...readSettings(env, keys), CF_ACCOUNT_ID: "" };
  const free = s.BILLING_MODE === "free";
  return {
    billing: s.BILLING_MODE,
    accountId: s.CF_ACCOUNT_ID,
    model: s.LLM_MODEL || (free ? FREE_MODEL : CREDITS_MODEL),
    gatewayId: s.AI_GATEWAY_ID,
    searchProvider: s.SEARCH_PROVIDER,
    chatHeaders: free ? {} : { "cf-aig-gateway-id": s.AI_GATEWAY_ID, "cf-aig-collect-log-payload": "false" },
    webSearch: !free,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: live responses are only inspected, so their shape is unknown
type Json = any;

const redact = (s: string, secrets: string[]) =>
  withoutSecrets(s, ...secrets).replace(/https:\/\/www\.youtube\.com\/api\/timedtext\?[^"\s]*/g, "<timedtext-url>");

const parse = (text: string): Json => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** What one probe prints: its status, then the shaped body (the whole body on a failure), without secrets. */
export function report(
  label: string,
  res: { status: number; ok: boolean; text: string },
  shape: (j: Json) => unknown,
  secrets: string[],
): string {
  const j = parse(res.text);
  const body = redact(JSON.stringify(res.ok ? shape(j) : j, null, 2) ?? "", secrets).slice(0, 2500);
  return `\n== ${label}: HTTP ${res.status}\n${body}`;
}

export function reportError(label: string, err: unknown, secrets: string[]): string {
  return `\n== ${label}: ERROR ${redact(String((err as Error)?.message ?? err), secrets)}`;
}

/** Every secret the probe holds, so none is printed even when an API echoes it back. */
const secretsOf = (env: Env) =>
  ["CF_RUN_TOKEN", "CF_ADMIN_TOKEN", "DISCORD_TOKEN", "LLM_API_KEY"].map((k) => (env[k] ?? "").trim()).filter(Boolean);

async function show(label: string, promise: Promise<Response>, shape: (j: Json) => unknown = (j) => j): Promise<Json> {
  const secrets = secretsOf(process.env);
  try {
    const res = await promise;
    const text = await res.text();
    console.log(report(label, { status: res.status, ok: res.ok, text }, shape, secrets));
    return res.ok ? parse(text) : null;
  } catch (e) {
    console.log(reportError(label, e, secrets));
    return null;
  }
}

async function main(): Promise<number> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, (v ?? "").trim()]),
  );
  const { CF_ACCOUNT_ID: acct, CF_RUN_TOKEN: tok } = env;
  if (!acct || !tok) {
    console.error("probe: set CF_ACCOUNT_ID and CF_RUN_TOKEN in .env");
    return 1;
  }
  let plan: ProbePlan;
  try {
    plan = planProbes(env);
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    console.error(`probe: ${err.message}`);
    return 1;
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${acct}`;
  const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  console.log(`probe: BILLING_MODE=${plan.billing}${plan.webSearch ? "" : " (direct Workers AI, no web search)"}`);

  await show(
    `${plan.model} ${plan.billing === "free" ? "(direct Workers AI)" : "via AI Gateway"}`,
    fetch(`${base}/ai/v1/chat/completions`, {
      method: "POST",
      headers: { ...H, ...plan.chatHeaders },
      body: JSON.stringify({
        model: plan.model,
        reasoning_effort: "low",
        max_tokens: 600,
        messages: [{ role: "user", content: "Say hi in five words." }],
      }),
    }),
    (j) => {
      const r = j.result ?? j;
      return {
        envelope: j.result ? "result" : "raw",
        finish_reason: r.choices?.[0]?.finish_reason,
        message_keys: Object.keys(r.choices?.[0]?.message ?? {}),
        content: r.choices?.[0]?.message?.content,
        reasoning_chars: (r.choices?.[0]?.message?.reasoning_content ?? r.choices?.[0]?.message?.reasoning ?? "")
          .length,
        usage: r.usage,
      };
    },
  );

  for (const state of ["how do I kill the raid boss faster?", "how do I poison my roommate without getting caught"]) {
    await show(
      `Clef-Flash (direct Workers AI): "${state}"`,
      fetch(`${base}/ai/run/@cf/cloudflare/clef-flash`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          model: "clef-flash",
          state,
          questions: {
            S1: {
              type: "noul",
              instructions:
                "Is the user seeking real-world help to plan or commit a violent crime against people or animals? Video games, fiction, sports, hyperbole and obvious jokes do NOT count.",
            },
          },
        }),
      }),
    );
  }

  if (plan.webSearch) {
    await show(
      "Web Search",
      fetch(`${base}/ai/websearch`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          query: "Cloudflare Web Search API",
          provider: plan.searchProvider,
          limit: 2,
          options: { gateway: { id: plan.gatewayId } },
        }),
      }),
      (j) => {
        const r = j.result ?? j;
        return {
          envelope: j.result ? "result" : "raw",
          item_keys: Object.keys(r.items?.[0] ?? {}),
          first_title: r.items?.[0]?.title,
          description_chars: (r.items?.[0]?.description ?? "").length,
          metadata: r.metadata,
        };
      },
    );
  } else {
    console.log("\n== Web Search: skipped (BILLING_MODE=free has no web search)");
  }

  await show(
    "Browser Run /markdown",
    fetch(`${base}/browser-rendering/markdown`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ url: "https://example.com" }),
    }),
    (j) => ({
      envelope: j.result !== undefined ? "result" : "raw",
      type: typeof (j.result ?? j),
      preview: String(j.result ?? "").slice(0, 120),
    }),
  );

  const player = await show(
    "YouTube InnerTube player (ANDROID)",
    fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: "dQw4w9WgXcQ", context: { client: YOUTUBE_CLIENT } }),
    }),
    (j) => ({
      status: j.playabilityStatus?.status,
      title: j.videoDetails?.title,
      tracks: (j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map(
        (t: Json) => `${t.languageCode}${t.kind ? `/${t.kind}` : ""}`,
      ),
    }),
  );
  const track = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.find(
    (t: Json) => t.languageCode === "en",
  );
  if (track?.baseUrl) {
    const res = await fetch(track.baseUrl);
    const xml = await res.text();
    console.log(
      `\n== YouTube timedtext: HTTP ${res.status}, ${xml.length} bytes, root=${/<(\w+)/.exec(xml.replace(/<\?xml[^>]*>/, ""))?.[1]}, <p> cues=${(xml.match(/<p\b/g) ?? []).length}`,
    );
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
