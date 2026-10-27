import type { Budget } from "./budget.ts";
import { FreeAllowanceError } from "./cf.ts";
import type { Config } from "./config.ts";
import {
  buildMessages,
  type ChatMessage,
  type EarlierImage,
  fitHistory,
  HISTORY_MAX_CHARS,
  historyImages,
  MAX_IMAGES_PER_REQUEST,
  type Msg,
  stripInvisible,
  type VideoContext,
} from "./context.ts";
import type { EarlierImages } from "./earlierimages.ts";
import { describeError } from "./errors.ts";
import {
  deletedNote,
  type EventChange,
  type EventPlace,
  eventEditScreenText,
  eventScreenText,
  type ScheduledEvent,
  type ServerEvents,
} from "./event.ts";
import type { GuardVerdict, ScreenVerdict } from "./guard.ts";
import { imageDataUrl } from "./images.ts";
import type { Limits } from "./limits.ts";
import { givenLinks, type LinkSet } from "./links.ts";
import { LlmError, type LlmResult } from "./llm.ts";
import type { Poll } from "./poll.ts";
import type { Attachment } from "./tools.ts";
import type { VideoResult } from "./video.ts";
import { type VideoWatch, videoOverview } from "./videolook.ts";

/** The bot's fixed replies. Safety texts (selfHarm, guardDown, allowanceOut) come from code; the rest can come from the persona. */
export type Replies = {
  blocked: string;
  selfHarm: string;
  outOfBudget: string;
  busy: string;
  error: string;
  guardDown: string;
  /** Workers AI's free daily allowance is used up: nothing works again until 00:00 UTC. */
  allowanceOut: string;
  /** Appended when a generated image failed the safety screen, or couldn't be checked. */
  imageBlocked: string;
  imageUnchecked: string;
  empty: string;
  emptyAnswer: string;
  cooldown: (seconds: number) => string;
  noAttach: string;
  noPoll: string;
  /** Appended when an event was made but the asker or the bot can't create events here. */
  noEvent: string;
  /** Posted when Discord refused to create the event. */
  eventFailed: string;
  /** Posted when the event couldn't be changed: Discord refused, or the event or the permissions changed meanwhile. */
  eventChangeFailed: string;
  /** Posted when the event couldn't be deleted, for the same reasons. */
  eventDeleteFailed: string;
};

/** One @mention, already translated out of Discord's types by the adapter. */
export type RespondRequest = {
  userId: string;
  /** For logs, e.g. "amy(123)". */
  who: string;
  /** For logs: the server name. */
  where: string;
  channelId: string;
  question: Msg;
  replyTo: Msg | null;
  /** Images in the asker's own message (and anything they forwarded). */
  imageUrls: string[];
  /** Images in the message they replied to: someone else's, so a block over them earns no strike. */
  replyImageUrls?: string[];
  /** The Discord-hosted video to watch (already picked by metadata), and notes about videos that were declined. */
  video?: { urls: string[]; skipped: string[] };
  /** What the bot may do in this channel. */
  can: { send: boolean; attach: boolean; poll: boolean };
  /** MENTIONS allows @everyone, the asker has Mention Everyone, and their own message asks for it. */
  mayPingEveryone: boolean;
  /** The asker and the bot both have Create Events on this server. */
  mayCreateEvents: boolean;
  /** The asker and the bot both have Send Polls in this channel. */
  mayCreatePolls: boolean;
  /** When an event or poll may not be made, what the model is told instead (the one reason that applies). */
  refusals?: { event?: string; poll?: string };
  /** The server's events as the asker can see them, for the event tools; null outside a server. */
  events: ServerEvents | null;
  /**
   * The asker's own words, without what they forwarded, and the text of the message they replied to: deleting an
   * event needs a delete word in the first and the event named in either.
   */
  asked: { text: string; replyTo: string | null };
  history: () => Promise<Msg[]>;
  /** Called once all gates pass and real work starts (the adapter starts typing). */
  onWorking?: () => void;
};

export type RespondDeps = {
  cfg: Config;
  limits: Limits;
  budget: Budget;
  replies: Replies;
  /** The persona name, used to label the bot's own messages in the history. */
  botName: string;
  log: (line: string) => void;
  systemPrompt: () => string;
  downloadImages: (urls: string[]) => Promise<string[]>;
  readVideo: (urls: string[]) => Promise<VideoResult>;
  /** Opens the video for the model to look closer at (the video_frames tool): over the pool that was just screened. */
  /** `room`: how many images the request has space for beside the asker's own (MAX_IMAGES_PER_REQUEST less those). */
  videoWatch: (video: VideoResult, room: number) => VideoWatch;
  /**
   * Opens the history's images for the model to look at (the view_images tool); `room` as for videoWatch. `question` is
   * the asker's words, screened along with each image, since the question is what an image is asked about.
   */
  viewEarlierImages: (images: EarlierImage[], room: number, question: string) => EarlierImages;
  /** `videoText` is the transcript of an attached video ("" when it had none), or null when there is no video. */
  screenRequest: (
    question: string,
    replyTo: string | null,
    media: { images: string[]; replyImages: string[]; videoText: string | null; frames: string[] },
  ) => Promise<ScreenVerdict>;
  screenReply: (question: string, reply: string) => Promise<GuardVerdict>;
  /** Screens generated images (as data URLs) along with the text that describes them. */
  screenImages: (images: string[], context: string) => Promise<GuardVerdict>;
  answer: (
    messages: ChatMessage[],
    /**
     * `video` is set when the model may look closer at a watched video; without it, it has no video_frames tool.
     * `earlierImages` is set when the model may look at the history's images; without it, no view_images tool.
     * `links` is this reply's own set of links the model may open (tools.ts), starting with the ones the asker gave.
     */
    opts: {
      mayPingEveryone: boolean;
      mayCreateEvents: boolean;
      mayCreatePolls: boolean;
      refusals?: { event?: string; poll?: string };
      events: ServerEvents | null;
      asked: { text: string; replyTo: string | null };
      video: VideoWatch | null;
      earlierImages: EarlierImages | null;
      links: LinkSet;
    },
  ) => Promise<LlmResult>;
};

/**
 * What to post: text, plus any generated images, poll, new event and change to an event (made after the reply), and
 * whether the model asked to ping @everyone.
 */
type Outcome = {
  text: string;
  files: Attachment[];
  poll: Poll | null;
  event: ScheduledEvent | null;
  change: EventChange | null;
  pingEveryone: boolean;
};

const say = (text: string): Outcome => ({
  text,
  files: [],
  poll: null,
  event: null,
  change: null,
  pingEveryone: false,
});

/**
 * Decides how to answer one @mention: limits, budget, safety screens, the model, and what may be posted.
 * Returns null when the bot should stay silent. Never throws.
 */
export async function respond(req: RespondRequest, deps: RespondDeps): Promise<Outcome | null> {
  const { limits, replies, log } = deps;
  const user = req.userId;
  if (limits.isMuted(user)) return null;
  if (!req.can.send) {
    log(`can't reply in channel ${req.channelId} (missing Send Messages or Read Message History); ignoring`);
    return null;
  }
  const wait = limits.cooldownLeft(user);
  if (wait > 0) return limits.shouldWarnCooldown(user) ? say(replies.cooldown(wait)) : null;
  if (!limits.tryLock(req.channelId)) return limits.shouldWarnBusy(req.channelId, user) ? say(replies.busy) : null;
  try {
    return await work(req, deps);
  } catch (err) {
    log(`error user=${req.who}: ${describeError(err)}`);
    return say(replies.error);
  } finally {
    limits.unlock(req.channelId);
  }
}

async function work(req: RespondRequest, deps: RespondDeps): Promise<Outcome | null> {
  const { cfg, limits, budget, replies, log } = deps;
  // Text with invisible characters removed is what gets screened, shown to the model and posted.
  const question = visible(req.question);
  const replyTo = req.replyTo && visible(req.replyTo);
  if (!question.content && !question.attachments.length && !question.images.length && !replyTo)
    return say(replies.empty);
  if (budget.spentToday >= budget.capUsd) return outOfBudget(req, deps);
  limits.markUsed(req.userId);
  req.onWorking?.();

  // A model that takes no images gets none (it would reject the whole request); it is told they were there.
  const sees = cfg.llm.vision;
  const ownImages = sees ? await deps.downloadImages(req.imageUrls) : [];
  const replyImages = sees && req.replyImageUrls?.length ? await deps.downloadImages(req.replyImageUrls) : [];
  const images = [...ownImages, ...replyImages];
  const unseenImages = sees ? 0 : req.imageUrls.length + (req.replyImageUrls?.length ?? 0);
  // downloadImages skips what it can't fetch (a redirect, a timeout, a type it doesn't take): say so, to the log and the model.
  const asked = sees ? req.imageUrls.length + (req.replyImageUrls?.length ?? 0) : 0;
  const failedImages = asked - images.length;
  if (failedImages > 0) log(`images: ${failedImages} of ${asked} images couldn't be downloaded user=${req.who}`);
  const read = await watch(req, deps);
  const video =
    read && !sees && read.frames.length
      ? {
          ...read,
          frames: [],
          notes: [
            ...read.notes,
            "This model can't see images, so the video's frames weren't shown; only what was said in it is here.",
          ],
        }
      : read;
  const frames = video?.frames.map((f) => f.dataUrl) ?? [];
  let pre: ScreenVerdict;
  try {
    // Frames and transcript are screened here, before the model sees either.
    // A video that yielded nothing counts as no video, so it can't shield the asker's own words or images.
    const watched = video && (frames.length > 0 || video.transcript) ? video : null;
    pre = await deps.screenRequest(question.content, replyTo ? replyTo.content : null, {
      images: ownImages,
      replyImages,
      videoText: watched ? watched.transcript : null,
      frames,
    });
  } catch (err) {
    logGuardFailure(log, err);
    return say(err instanceof FreeAllowanceError ? replies.allowanceOut : replies.guardDown);
  }
  budget.commit(0, pre.costUsd);
  if (pre.blocked) {
    // Only the asker's own words earn a strike; a nasty replied-to message still blocks, strike-free.
    const n = pre.strike ? limits.addStrike(req.userId) : 0;
    log(
      `BLOCKED user=${req.who} category=${pre.category} p=${pre.p.toFixed(2)} strike=${pre.strike} strikes=${n}/${cfg.guard.strikeLimit}`,
    );
    return say(pre.selfHarm ? replies.selfHarm : replies.blocked);
  }

  // The model looks at an overview and may ask for more (video_frames) only when there is something to look at and
  // tools are on. Frames it is later given are screened too, but the pool above is already cleared.
  // Frames share the request's image limit with the asker's own images, which always stay.
  const room = MAX_IMAGES_PER_REQUEST - images.length;
  const look = frames.length > 0 && cfg.tools.maxCalls > 0 && video ? deps.videoWatch(video, room) : null;
  const history = fitHistory(await req.history(), HISTORY_MAX_CHARS, deps.botName);
  // The history's images can be shown only to a model that sees images and may call tools (view_images). They are
  // numbered from the history as fitted, so the numbers are the ones on the lines the model reads.
  const viewable = sees && cfg.tools.maxCalls > 0 ? historyImages(history, deps.botName) : [];
  const earlier = viewable.length ? deps.viewEarlierImages(viewable, room, question.content) : null;
  const system = deps.systemPrompt();
  // Links the model may open: the question's and the replied-to message's, and any page on a site the operator's
  // personality names (its own instructions). web_search adds its results during the reply.
  const links = givenLinks(question, replyTo);
  links.addSites(system);
  const messages = buildMessages({
    botName: deps.botName,
    system,
    question,
    replyTo,
    history,
    viewImages: earlier !== null,
    images,
    unseenImages,
    failedImages,
    video: videoContext(req, video, look, room),
  });

  let result: LlmResult;
  try {
    result = await deps.answer(messages, {
      mayPingEveryone: req.mayPingEveryone,
      mayCreateEvents: req.mayCreateEvents,
      mayCreatePolls: req.mayCreatePolls,
      refusals: req.refusals,
      events: req.events,
      asked: req.asked,
      video: look,
      earlierImages: earlier,
      links,
    });
  } catch (err) {
    if (err instanceof LlmError) {
      budget.commit(err.reservedUsd, err.reservedUsd);
      if (err.freeAllowance) {
        log("model: Workers AI free allowance exhausted (no reply until 00:00 UTC)");
        return say(replies.allowanceOut);
      }
    }
    throw err;
  }
  budget.commit(result.reservedUsd, result.costUsd);
  if (result.outOfBudget) return outOfBudget(req, deps);
  // The request screen never saw an earlier image the model then asked for. If that image was flagged for self-harm,
  // gork doesn't answer: the model's reply is dropped for the fixed one, as for a request flagged for self-harm. The
  // asker didn't post the image in their question, so there is no strike.
  if (earlier?.selfHarm) {
    log(`BLOCKED-EARLIER user=${req.who} self-harm: sending the fixed reply`);
    return say(replies.selfHarm);
  }

  const answerText = stripInvisible(result.text);
  let poll = result.poll && visiblePoll(result.poll);
  let event = result.event && visibleEvent(result.event);
  const change = result.change && visibleChange(result.change);
  const pollText = poll ? `\n\nPoll: ${poll.question}\nOptions: ${poll.answers.join(" | ")}` : "";
  // The note gork posts after a deletion is screened here too, so everything it posts has passed the screen.
  const changeText =
    change?.kind === "edit" ? eventEditScreenText(change.edit) : change ? `\n\n${deletedNote(change.event)}` : "";
  const eventText = event ? eventScreenText(event) : changeText;
  let post: GuardVerdict;
  try {
    post = await deps.screenReply(question.content, answerText + pollText + eventText);
  } catch (err) {
    // Fail closed: nothing the model produced goes out when the reply screen is down.
    logGuardFailure(log, err);
    return say(err instanceof FreeAllowanceError ? replies.allowanceOut : replies.guardDown);
  }
  budget.commit(0, post.costUsd);
  if (post.blocked) {
    log(`BLOCKED-REPLY user=${req.who} category=${post.category} p=${post.p.toFixed(2)}`);
    return say(post.selfHarm ? replies.selfHarm : replies.blocked);
  }

  let text = answerText || replies.emptyAnswer;
  let files = result.attachments;
  if (files.length && !req.can.attach) {
    text += `\n${replies.noAttach}`;
    files = [];
  } else if (files.length) {
    const screened = await screenFiles(files, text, deps);
    files = screened.files;
    if (screened.note) text += `\n${screened.note}`;
  }
  if (poll && !(req.can.poll && req.mayCreatePolls)) {
    text += `\n${replies.noPoll}`;
    poll = null;
  }
  if (event && !req.mayCreateEvents) {
    text += `\n${replies.noEvent}`;
    event = null;
  }
  const overview = video ? videoOverview(video.frames, room).length : 0;
  log(
    `reply user=${req.who} guild=${req.where} in=${result.promptTokens} out=${result.completionTokens}${result.usageEstimated ? "(est)" : ""} tools=${result.toolCalls} search=${result.searches.primary}+${result.searches.fallback} imgs=${images.length} frames=${frames.length} overview=${overview} shown=${look ? look.framesShown : overview} earlier=${earlier?.shown ?? 0} gen=${files.length} poll=${poll ? 1 : 0} event=${event ? "create" : (change?.kind ?? 0)} cost=$${result.costUsd.toFixed(5)} today=$${budget.spentToday.toFixed(4)}/$${budget.capUsd}`,
  );
  // A change to an event isn't gated here: discord-event.ts checks the asker's and gork's permissions again, with the
  // event read afresh, before it makes the change.
  return { text, files, poll, event, change, pingEveryone: result.pingEveryone && req.mayPingEveryone };
}

/**
 * The one place attachments are screened, so a new tool that attaches something can't skip it. Fails closed:
 * a file that is blocked, isn't a recognisable image, or couldn't be checked is dropped and the reply says so.
 */
async function screenFiles(
  files: Attachment[],
  caption: string,
  deps: RespondDeps,
): Promise<{ files: Attachment[]; note: string | null }> {
  const { budget, replies, log } = deps;
  const images: string[] = [];
  for (const f of files) {
    const url = imageDataUrl(f.data);
    if (!url) {
      log(`attachment ${f.name} dropped: not an image the safety screen can check`);
      return { files: [], note: replies.imageUnchecked };
    }
    images.push(url);
  }
  const prompts = files.map((f) => `Image prompt: ${f.prompt ?? "(none)"}`).join("\n");
  try {
    const verdict = await deps.screenImages(images, `${prompts}\nCaption: ${caption.slice(0, 1000)}`);
    budget.commit(0, verdict.costUsd);
    if (!verdict.blocked) return { files, note: null };
    log(`BLOCKED-IMAGE category=${verdict.category} p=${verdict.p.toFixed(2)}`);
    return { files: [], note: replies.imageBlocked };
  } catch (err) {
    logGuardFailure(log, err);
    return { files: [], note: replies.imageUnchecked };
  }
}

const visible = (m: Msg): Msg => ({ ...m, content: stripInvisible(m.content) });

const visiblePoll = (p: Poll): Poll => ({
  ...p,
  question: stripInvisible(p.question),
  answers: p.answers.map(stripInvisible),
});

const visiblePlace = (where: EventPlace): EventPlace =>
  where.kind === "voice"
    ? { kind: "voice", channel: stripInvisible(where.channel) }
    : { kind: "location", text: stripInvisible(where.text) };

const visibleEvent = (ev: ScheduledEvent): ScheduledEvent => ({
  ...ev,
  name: stripInvisible(ev.name),
  description: ev.description && stripInvisible(ev.description),
  where: visiblePlace(ev.where),
});

const visibleChange = (change: EventChange): EventChange => {
  if (change.kind === "delete") return change;
  const { name, where, description } = change.edit;
  const edit = {
    ...change.edit,
    ...(name ? { name: stripInvisible(name) } : {}),
    ...(where ? { where: visiblePlace(where) } : {}),
    ...(description ? { description: stripInvisible(description) } : {}),
  };
  return { ...change, edit };
};

function outOfBudget(req: RespondRequest, deps: RespondDeps): Outcome | null {
  const { budget, limits, replies, log } = deps;
  log(`budget cap hit user=${req.who} today=$${budget.spentToday.toFixed(4)}/$${budget.capUsd}`);
  return limits.shouldWarnOutOfBudget(req.userId) ? say(replies.outOfBudget) : null;
}

function logGuardFailure(log: (line: string) => void, err: unknown): void {
  log(
    err instanceof FreeAllowanceError
      ? "guard: Workers AI free allowance exhausted (failing closed)"
      : `guard error (failing closed): ${describeError(err)}`,
  );
}

/** Reads the video, if there is one, and settles its cost. Never throws: a failed read becomes a note. */
async function watch(req: RespondRequest, deps: RespondDeps): Promise<VideoResult | null> {
  if (!req.video?.urls.length) return null;
  let video: VideoResult;
  try {
    video = await deps.readVideo(req.video.urls);
  } catch (err) {
    deps.log(`video error user=${req.who}: ${describeError(err)}`);
    return {
      frames: [],
      url: "",
      transcript: "",
      notes: ["A video was attached, but it couldn't be read."],
      costUsd: 0,
      reservedUsd: 0,
    };
  }
  deps.budget.commit(video.reservedUsd, video.costUsd);
  return video;
}

/** What the model is told about the video: the overview (not the whole pool), its length, and the tool if it has it. */
function videoContext(
  req: RespondRequest,
  video: VideoResult | null,
  look: VideoWatch | null,
  room: number,
): VideoContext | undefined {
  const notes = [...(req.video?.skipped ?? []), ...(video?.notes ?? [])];
  if (!video && !notes.length) return undefined;
  const frames = video ? videoOverview(video.frames, room) : [];
  return {
    frames,
    transcript: video?.transcript ?? "",
    notes,
    lengthSec: video?.frames.length,
    lookCloser: look ? { perCall: look.perCall, left: look.framesLeft } : undefined,
  };
}
