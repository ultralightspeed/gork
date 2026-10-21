// One-off live probe of every external API gork uses (npm run probe). Prints status codes, shapes and usage only:
// never headers, tokens, or signed caption URLs. Follows BILLING_MODE like the bot: in free mode it calls Workers AI
// directly (no gateway header, the free model) and skips the paid web search.
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { withoutSecrets } from "../src/cf.ts";
import { CREDITS_MODEL, FREE_MODEL, readSettings, SettingsError, searchFallbackOf } from "../src/config.ts";
import { type ChatMessage, forWire, toolImagesMessage } from "../src/context.ts";
import { distrustRoots, OLD_NODE_WARNING } from "../src/distrust.ts";
import { type SearchProvider, searchPrice } from "../src/search-providers.ts";
import { YOUTUBE_CLIENT } from "../src/youtube.ts";

type Env = Record<string, string | undefined>;

interface ProbePlan {
  billing: "credits" | "free";
  accountId: string;
  model: string;
  gatewayId: string;
  searchProvider: SearchProvider;
  /** The fallback provider (SEARCH_FALLBACK), or null when there is none; probed too. */
  searchFallback: SearchProvider | null;
  /** The chat call's extra headers: the gateway ones in credits mode, none in free mode. */
  chatHeaders: Record<string, string>;
  /** Web search is paid and credits-only. */
  webSearch: boolean;
}

/** What to probe, from the same settings the bot reads. Throws SettingsError on a bad value. */
export function planProbes(env: Env): ProbePlan {
  // The account id goes into the URL path, so a set one is validated like the bot does (blank is main's problem).
  const keys = [
    "BILLING_MODE",
    "AI_GATEWAY_ID",
    "SEARCH_PROVIDER",
    "SEARCH_FALLBACK",
    "SEARCH_FALLBACK_PER_DAY",
    "LLM_MODEL",
  ] as const;
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
    searchFallback: searchFallbackOf(s),
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

type Rgb = [number, number, number];

/** A 64x64 PNG data URL, its left half one colour and its right half another: only a model that sees it can say which. */
export function splitPng(left: Rgb, right: Rgb): string {
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size); // each row: filter byte 0, then the RGB pixels
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) raw.set(x < size / 2 ? left : right, y * (size * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

type ToolCall = { id: string; type?: string; function?: { name?: string; arguments?: unknown } };

/**
 * The second request of the tool round-trip, as the bot builds it (src/llm.ts): the model's call, its tool message
 * straight after, then, for a model that sees, the images in a user message after every tool message (video_frames).
 */
export function roundTripMessages(ask: ChatMessage, call: ToolCall, image: string | null): ChatMessage[] {
  const messages: ChatMessage[] = [
    ask,
    { role: "assistant", content: "", tool_calls: [call] } as ChatMessage,
    {
      role: "tool",
      tool_call_id: call.id,
      content: image ? "1 image; it is in the next message." : "Nothing to show.",
    },
  ];
  const images = image ? toolImagesMessage([{ label: "Image", dataUrl: image }]) : null;
  return images ? [...messages, images] : messages;
}

const LOOK_TOOL = {
  type: "function",
  function: {
    name: "look",
    description: "Shows you an image. Takes no arguments.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

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

  // The tool round-trip: a tool call, its answer, and (for a model that sees) an image in a user message after the tool
  // message, the shape video_frames depends on. The image is green on the left and magenta on the right.
  const chatUrl = `${base}/ai/v1/chat/completions`;
  const chatBody = (messages: ChatMessage[]) =>
    JSON.stringify({ model: plan.model, reasoning_effort: "low", max_tokens: 600, messages, tools: [LOOK_TOOL] });
  const sees = plan.model !== FREE_MODEL;
  const ask: ChatMessage = {
    role: "user",
    content: sees
      ? "Call the look tool. Then say which colour fills the left half of the image and which fills the right half."
      : "Call the look tool, then tell me what it said.",
  };
  const first = await show(
    `${plan.model}: tool call`,
    fetch(chatUrl, { method: "POST", headers: { ...H, ...plan.chatHeaders }, body: chatBody([ask]) }),
    (j) => ({
      tool_calls: ((j.result ?? j).choices?.[0]?.message?.tool_calls ?? []).map((c: Json) => c.function?.name),
    }),
  );
  const call: ToolCall | undefined = (first?.result ?? first)?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) console.log("\n== tool result: skipped (no tool call came back)");
  else
    await show(
      `${plan.model}: tool result${sees ? ", then an image after the tool message" : ""}`,
      fetch(chatUrl, {
        method: "POST",
        headers: { ...H, ...plan.chatHeaders },
        body: chatBody(forWire(roundTripMessages(ask, call, sees ? splitPng([0, 200, 0], [230, 0, 230]) : null))),
      }),
      (j) => ({
        content: (j.result ?? j).choices?.[0]?.message?.content,
        ...(sees ? { expected: "left green, right magenta" } : {}),
      }),
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
    // The provider, then the fallback if there is one: a search each, at each provider's price.
    const providers = [plan.searchProvider, ...(plan.searchFallback ? [plan.searchFallback] : [])];
    for (const [i, provider] of providers.entries()) {
      await show(
        `Web Search (${provider}${i ? ", the fallback" : ""}, $${searchPrice(provider)})`,
        fetch(`${base}/ai/websearch`, {
          method: "POST",
          headers: H,
          body: JSON.stringify({
            query: "Cloudflare Web Search API",
            provider,
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
    }
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (distrustRoots() === null) console.warn(`probe: ${OLD_NODE_WARNING}`);
  process.exitCode = await main();
}
