// Images from Discord messages, fetched only from Discord's own CDN and shrunk by its media proxy.
import { readCapped } from "./http.ts";

const HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const STILL_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_PATH = /\.(png|jpe?g|webp)$/i;
const GIF_PATH = /\.gif$/i;
const MAX_BYTES = 4 * 1024 * 1024;

export type ImageSource = { url: string; contentType?: string | null };

/**
 * Discord-hosted images, at most `max`. Stills are shrunk to <=1024px by the media proxy; GIFs are requested as a
 * PNG of their first frame (`format=png`). If the proxy doesn't convert one, downloadImages drops it.
 */
export function pickImageUrls(sources: ImageSource[], max: number): string[] {
  const out: string[] = [];
  for (const s of sources) {
    if (out.length >= max) break;
    let u: URL;
    try {
      u = new URL(s.url);
    } catch {
      continue;
    }
    const external = /^images-ext-\d+\.discordapp\.net$/.test(u.hostname); // Discord's proxy for link-preview images
    if (u.protocol !== "https:" || (!HOSTS.has(u.hostname) && !external)) continue;
    const type = s.contentType?.split(";")[0].trim();
    const gif = type ? type === "image/gif" : GIF_PATH.test(u.pathname);
    const still = type ? STILL_TYPES.has(type) : IMAGE_PATH.test(u.pathname);
    if (!gif && !still) continue;
    if (gif) u.searchParams.set("format", "png");
    if (!external) {
      u.hostname = "media.discordapp.net";
      u.searchParams.set("width", "1024");
      u.searchParams.set("height", "1024");
    }
    out.push(u.href);
  }
  return out;
}

/** The type of a PNG or JPEG judged by its first bytes (what the generator and Discord actually send), else null. */
export function sniffImageMime(data: Uint8Array): "image/png" | "image/jpeg" | null {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  return null;
}

/** A PNG or JPEG as a data URL for the vision models, or null when the bytes aren't one. */
export function imageDataUrl(data: Buffer): string | null {
  const mime = sniffImageMime(data);
  return mime && `data:${mime};base64,${data.toString("base64")}`;
}

/**
 * Downloads images as data URLs. Failures are skipped, never thrown. A redirect counts as a failure, so a download
 * never leaves Discord's hosts, and no more than MAX_BYTES of a body is read.
 */
export async function downloadImages(urls: string[], fetchFn: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!res.ok || !STILL_TYPES.has(type)) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const buf = await readCapped(res, MAX_BYTES);
      if (!buf || buf.length === 0) continue;
      out.push(`data:${type};base64,${buf.toString("base64")}`);
    } catch {
      // skip this image
    }
  }
  return out;
}
