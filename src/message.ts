// Maps Discord messages to what the prompt and the image pipeline need. The input types are structural so
// tests can use plain objects; discord.js's Message and MessageSnapshot satisfy them.
import type { Msg } from "./context.ts";
import type { ImageSource } from "./images.ts";
import type { VideoSource } from "./video.ts";

type AttachmentLike = {
  url: string;
  contentType?: string | null;
  size?: number;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
};
type EmbedLike = {
  title?: string | null;
  url?: string | null;
  description?: string | null;
  fields: { name: string; value: string }[];
  image?: { proxyURL?: string } | null;
  thumbnail?: { proxyURL?: string } | null;
};
type MessageLike = {
  content: string;
  attachments: { values(): Iterable<AttachmentLike> };
  embeds: EmbedLike[];
};
// A forwarded Discord message keeps its own content empty; the original's text, embeds and attachments
// live in message snapshots. Reading those makes forwards look like what people actually see.
type Forwardable = MessageLike & { messageSnapshots?: { values(): Iterable<MessageLike> } };

/** The message followed by any forwarded snapshots it carries. */
export function withForwards(m: Forwardable): MessageLike[] {
  return [m, ...(m.messageSnapshots ? [...m.messageSnapshots.values()] : [])];
}

/** Text of forwarded snapshots, labelled, or "" when the message isn't a forward. */
export function forwardedText(m: Forwardable): string {
  return withForwards(m)
    .slice(1)
    .map((s) => s.content.trim())
    .filter(Boolean)
    .map((c) => `[forwarded message] ${c}`)
    .join("\n");
}

const embedText = (e: EmbedLike) =>
  [e.title, e.url, e.description, ...e.fields.map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join(" - ");

/** Replaces user and role mentions with readable @names; unknown ones become @someone and @role. */
export function resolveNames(
  m: {
    mentions: {
      members?: { get(id: string): { displayName: string } | undefined } | null;
      users: { get(id: string): { username: string } | undefined };
    };
    guild?: { roles: { cache: { get(id: string): { name: string } | undefined } } } | null;
  },
  text: string,
): string {
  return text
    .replace(
      /<@!?(\d+)>/g,
      (_s, id: string) =>
        `@${m.mentions.members?.get(id)?.displayName ?? m.mentions.users.get(id)?.username ?? "someone"}`,
    )
    .replace(/<@&(\d+)>/g, (_s, id: string) => `@${m.guild?.roles.cache.get(id)?.name ?? "role"}`);
}

/** The message reduced to what the prompt needs; `content` is the already-cleaned text. */
export function toMsg(
  m: Forwardable & {
    author: { id: string; username: string; displayName?: string | null };
    member?: { displayName: string } | null;
  },
  content: string,
  selfId: string | undefined,
): Msg {
  const parts = withForwards(m);
  return {
    authorName: m.member?.displayName ?? m.author.displayName ?? m.author.username,
    isSelf: m.author.id === selfId,
    content: [content, forwardedText(m)].filter(Boolean).join("\n"),
    attachments: parts.flatMap((p) => [...p.attachments.values()].map((a) => a.contentType ?? "file")),
    embeds: parts.flatMap((p) => p.embeds.map(embedText)).filter(Boolean),
  };
}

/** Attachments and embed image/thumbnail proxy URLs, from the message and its forwarded snapshots. */
export function imageSources(m: Forwardable): ImageSource[] {
  return withForwards(m).flatMap((p) => {
    const fromAttachments = [...p.attachments.values()].map((a) => ({ url: a.url, contentType: a.contentType }));
    const fromEmbeds = p.embeds
      .flatMap((e) => [e.image?.proxyURL, e.thumbnail?.proxyURL])
      .filter((u): u is string => !!u)
      .map((url) => ({ url }));
    return [...fromAttachments, ...fromEmbeds];
  });
}

/** Attachments with the metadata that lets a video be declined before it is fetched (from the message and its forwards). */
export function videoSources(m: Forwardable): VideoSource[] {
  return withForwards(m).flatMap((p) =>
    [...p.attachments.values()].map((a) => ({
      url: a.url,
      contentType: a.contentType,
      ...(a.size != null && { size: a.size }),
      ...(a.duration != null && { durationSec: a.duration }),
      ...(a.width != null && { width: a.width }),
      ...(a.height != null && { height: a.height }),
    })),
  );
}
