import { CfError, isFreeAllowanceExhausted, readText, unwrapResult, withoutSecrets } from "./cf.ts";
import type { Config } from "./config.ts";
import { type ChatMessage, fitImages, forWire, type ToolImage, toolImagesMessage } from "./context.ts";
import type { ScheduledEvent } from "./event.ts";
import type { Poll } from "./poll.ts";
import { SEARCH_COST_USD } from "./search.ts";
import { type Attachment, type ReplyTally, type ToolResult, toolDefs } from "./tools.ts";

export type LlmResult = {
  text: string;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  costUsd: number;
  reservedUsd: number;
  usageEstimated: boolean;
  outOfBudget: boolean;
  attachments: Attachment[];
  poll: Poll | null;
  event: ScheduledEvent | null;
  /** A tool asked for this reply to ping @everyone/@here. */
  pingEveryone: boolean;
};

/** An LLM HTTP failure; carries what was reserved so the caller can settle the ledger. */
export class LlmError extends Error {
  reservedUsd: number;
  /** Free mode only: the Workers AI free daily allowance is used up. */
  freeAllowance: boolean;
  constructor(message: string, reservedUsd: number, freeAllowance = false) {
    super(message);
    this.reservedUsd = reservedUsd;
    this.freeAllowance = freeAllowance;
  }
}

class ChatHttpError extends CfError {
  freeAllowance: boolean;
  constructor(status: number, body: string, freeAllowance: boolean) {
    super(status, body);
    this.freeAllowance = freeAllowance;
  }
}

type Completion = {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: unknown } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

const LLM_TIMEOUT_MS = 60_000;
/** Most bytes read of a model answer; MAX_OUTPUT_TOKENS of text is far less. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
/** Most tokens one model call may produce, reasoning included. */
export const MAX_OUTPUT_TOKENS = 1500;
/** After this long on one reply the model stops using tools and answers with what it has. */
export const REPLY_DEADLINE_SECONDS = 90;
/**
 * Input tokens reserved for each image part. Sized for a 1024px image from a message; a 640px video frame is about
 * 600, so frames are over-reserved. That is harmless: the reservation is only a hold, and the real tokens the model
 * reports settle it. It counts every image part in the conversation, including the ones tools return.
 */
export const IMAGE_TOKENS = 1200;
const estTokens = (messages: ChatMessage[]) =>
  messages.reduce((n, m) => {
    if (typeof m.content === "string") return n + Math.ceil((m.content.length + 20) / 3.5);
    return n + m.content.reduce((k, p) => k + (p.type === "text" ? Math.ceil(p.text.length / 3.5) : IMAGE_TOKENS), 6);
  }, 0);

export function cleanText(content: unknown): string {
  let raw = typeof content === "string" ? content : "";
  const close = raw.lastIndexOf("</think>");
  if (close !== -1) raw = raw.slice(close + "</think>".length);
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
  return text;
}

async function chat(
  cfg: Config,
  messages: ChatMessage[],
  tools: ReturnType<typeof toolDefs> | null,
  fetchFn: typeof fetch,
): Promise<Completion> {
  const body: Record<string, unknown> = {
    model: cfg.llm.model,
    messages: forWire(messages),
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.7,
  };
  if (cfg.llm.reasoningEffort !== "off") body.reasoning_effort = cfg.llm.reasoningEffort;
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const free = cfg.billing === "free";
  const res = await fetchFn(`${cfg.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.llm.apiKey}`,
      "Content-Type": "application/json",
      // Free mode is Workers AI called directly, like the image path: no gateway header, so unified billing
      // (credits) can never apply. loadConfig refuses a base URL that is not api.cloudflare.com in free mode.
      ...(free ? {} : { "cf-aig-gateway-id": cfg.cf.gatewayId, "cf-aig-collect-log-payload": "false" }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  const text = withoutSecrets(await readText(res, MAX_ANSWER_BYTES, "LLM"), cfg.llm.apiKey);
  if (!res.ok) {
    // Only free mode reads a 429 as "allowance used up"; with the gateway it is the gateway's rate limit.
    const exhausted = free && isFreeAllowanceExhausted(new CfError(res.status, text));
    throw new ChatHttpError(res.status, text, exhausted);
  }
  try {
    return unwrapResult<Completion>(JSON.parse(text));
  } catch {
    // JSON.parse's own message quotes the start of the body.
    throw new Error(`LLM HTTP ${res.status}: the answer is not valid JSON`);
  }
}

/** A token count from the answer, or undefined when it is missing or not a usable number. */
const tokenCount = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * Answers with the model, letting it call tools up to cfg.tools.maxCalls times, and only until the reply deadline
 * (REPLY_DEADLINE_SECONDS): after that, tools are off and the model must answer with what it has.
 * Reserves budget before every model call; stops with outOfBudget when a reservation is refused.
 */
export async function answer(
  cfg: Config,
  messages: ChatMessage[],
  deps: {
    fetch?: typeof fetch;
    runTool: (name: string, args: unknown, tally: ReplyTally) => Promise<ToolResult>;
    reserve: (usd: number) => boolean;
    /** The clock, in ms; injectable for tests. */
    now?: () => number;
    /** This request has a watched video, so the model is offered the video_frames tool. */
    videoTool?: boolean;
  },
): Promise<LlmResult> {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const deadline = now() + REPLY_DEADLINE_SECONDS * 1000;
  const attachments: Attachment[] = [];
  let poll: Poll | null = null;
  let event: ScheduledEvent | null = null;
  let pingEveryone = false;
  const convo = [...messages];
  let toolCalls = 0,
    pt = 0,
    ct = 0,
    toolCost = 0,
    reserved = 0,
    estimated = false;
  const result = (text: string, outOfBudget = false): LlmResult => ({
    text,
    promptTokens: pt,
    completionTokens: ct,
    toolCalls,
    costUsd: (pt * cfg.llm.priceInPerM + ct * cfg.llm.priceOutPerM) / 1e6 + toolCost,
    reservedUsd: reserved,
    usageEstimated: estimated,
    outOfBudget,
    attachments,
    poll,
    event,
    pingEveryone,
  });
  for (;;) {
    const toolsOn = toolCalls < cfg.tools.maxCalls && now() < deadline;
    // What is sent: the conversation with its oldest video frames dropped past the per-request image limit.
    const sent = fitImages(convo);
    // Searches are reserved one by one as they run, below: a round can make several.
    const roundUsd = (estTokens(sent) * cfg.llm.priceInPerM + MAX_OUTPUT_TOKENS * cfg.llm.priceOutPerM) / 1e6;
    if (!deps.reserve(roundUsd)) return result("", true);
    reserved += roundUsd;
    let data: Completion;
    try {
      data = await chat(cfg, sent, toolsOn ? toolDefs(cfg, { video: deps.videoTool }) : null, f);
    } catch (err) {
      const message =
        err instanceof ChatHttpError ? `LLM HTTP ${err.status}: ${err.body.slice(0, 160)}` : (err as Error).message;
      throw new LlmError(message, reserved, err instanceof ChatHttpError && err.freeAllowance);
    }
    // The answer is only cast, not checked: a count that isn't a number counts as missing, so the cost stays a number.
    const inTokens = tokenCount(data.usage?.prompt_tokens);
    const outTokens = tokenCount(data.usage?.completion_tokens);
    if (inTokens === undefined || outTokens === undefined) estimated = true;
    pt += inTokens ?? estTokens(sent);
    ct += outTokens ?? MAX_OUTPUT_TOKENS;
    const msg = data.choices?.[0]?.message ?? {};
    if (msg.tool_calls != null && !Array.isArray(msg.tool_calls))
      throw new LlmError(`${cfg.llm.model} sent tool_calls that is not a list`, reserved);
    const calls = toolsOn ? (msg.tool_calls ?? []) : [];
    if (calls.length === 0) return result(cleanText(msg.content));
    convo.push({ role: "assistant", content: typeof msg.content === "string" ? msg.content : "", tool_calls: calls });
    const roundImages: ToolImage[] = [];
    for (const call of calls) {
      toolCalls++;
      let content: string;
      if (toolCalls > cfg.tools.maxCalls) content = "Tool limit reached. Answer with what you have.";
      else if (now() >= deadline) content = "Out of time. Answer with what you have.";
      else if (call.function?.name === "web_search" && cfg.billing !== "free" && !deps.reserve(SEARCH_COST_USD))
        content = "The daily budget is used up, so that search wasn't run. Answer with what you have.";
      else {
        if (call.function?.name === "web_search" && cfg.billing !== "free") reserved += SEARCH_COST_USD;
        const r = await deps.runTool(call.function?.name ?? "", call.function?.arguments ?? "", {
          images: attachments.length,
          polls: poll ? 1 : 0,
          events: event ? 1 : 0,
        });
        content = r.content;
        toolCost += r.costUsd;
        if (r.images) roundImages.push(...r.images);
        if (r.attachment) attachments.push(r.attachment);
        if (r.poll && !poll) poll = r.poll;
        if (r.event && !event) event = r.event;
        if (r.pingEveryone) pingEveryone = true;
      }
      convo.push({ role: "tool", tool_call_id: call.id, content });
    }
    // After every tool message of the round, never between them (a tool message must follow its call directly).
    const images = toolImagesMessage(roundImages);
    if (images) convo.push(images);
  }
}
