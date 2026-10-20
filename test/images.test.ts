import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { downloadImages, imageDataUrl, pickImageUrls, sniffImageMime } from "../src/images.ts";

describe("pickImageUrls", () => {
  it("keeps only Discord-hosted still images, shrunk through the media proxy, capped at max", () => {
    const urls = pickImageUrls(
      [
        { url: "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1", contentType: "image/png" },
        { url: "https://media.discordapp.net/attachments/1/2/b.jpg", contentType: "image/jpeg" },
        { url: "https://evil.example/c.png", contentType: "image/png" },
        { url: "https://cdn.discordapp.com/attachments/1/2/d.pdf", contentType: "application/pdf" },
        { url: "https://cdn.discordapp.com/attachments/1/2/e.webp", contentType: "image/webp" },
        { url: "https://cdn.discordapp.com/attachments/1/2/f.png", contentType: "image/png" },
      ],
      3,
    );
    // The evil host and the PDF are skipped, and the cap stops it before f.png.
    expect(urls).toEqual([
      "https://media.discordapp.net/attachments/1/2/a.png?ex=1&width=1024&height=1024",
      "https://media.discordapp.net/attachments/1/2/b.jpg?width=1024&height=1024",
      "https://media.discordapp.net/attachments/1/2/e.webp?width=1024&height=1024",
    ]);
    // Plain http is refused even on a Discord host.
    expect(
      pickImageUrls([{ url: "http://cdn.discordapp.com/attachments/1/2/a.png", contentType: "image/png" }], 3),
    ).toEqual([]);
  });

  it("accepts Discord's external media proxy used by link previews, without rewriting it", () => {
    const u = "https://images-ext-1.discordapp.net/external/abc/https/pbs.twimg.com/media/y.jpg";
    expect(pickImageUrls([{ url: u }], 3)).toEqual([u]);
    for (const other of ["https://images-ext-1.evil.net/x.jpg", "https://images-ext-1.discordapp.net.evil.net/x.jpg"])
      expect(pickImageUrls([{ url: other }], 3), other).toEqual([]);
  });

  it("asks for a PNG first frame of GIFs, uploaded or link-preview, and judges an untyped embed by its path", () => {
    const [upload, preview] = pickImageUrls(
      [
        { url: "https://cdn.discordapp.com/attachments/1/2/dance.gif?ex=1", contentType: "image/gif" },
        { url: "https://images-ext-1.discordapp.net/external/abc/https/media.giphy.com/x/giphy.gif" },
      ],
      3,
    );
    expect(upload.startsWith("https://media.discordapp.net/attachments/1/2/dance.gif")).toBe(true);
    expect(new URL(upload).searchParams.get("format")).toBe("png");
    expect(new URL(preview).hostname).toBe("images-ext-1.discordapp.net"); // the host is not changed
    expect(new URL(preview).searchParams.get("format")).toBe("png");
    expect(
      pickImageUrls([{ url: "https://media.discordapp.net/external/x/https/pbs.twimg.com/y.jpg" }], 3),
    ).toHaveLength(1);
    expect(pickImageUrls([{ url: "https://media.discordapp.net/external/x/page.html" }], 3)).toHaveLength(0);
  });
});

describe("downloadImages", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const asFetch = (route: () => Promise<Response>) => (async () => route()) as typeof fetch;

  it("returns data URLs for successful image downloads", async () => {
    const f = asFetch(async () => new Response(png, { headers: { "content-type": "image/png" } }));
    const out = await downloadImages(["https://media.discordapp.net/a.png"], f);
    expect(out).toEqual([`data:image/png;base64,${Buffer.from(png).toString("base64")}`]);
  });

  it("skips non-images, a GIF the proxy did not convert, HTTP errors and network failures without throwing", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      async () => new Response(new Uint8Array([0x47, 0x49, 0x46]), { headers: { "content-type": "image/gif" } }),
      async () => new Response("nope", { status: 404, headers: { "content-type": "image/png" } }),
      async () => new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } }),
      async () => {
        throw new Error("boom");
      },
    ];
    const urls = responses.map((_, i) => `https://media.discordapp.net/${i}`);
    expect(
      await downloadImages(
        urls,
        asFetch(() => (responses.shift() as () => Promise<Response>)()),
      ),
    ).toEqual([]);
  });

  it("refuses a redirect instead of following it off Discord's hosts", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/a.png") res.writeHead(302, { location: "/b.png" }).end();
      else res.writeHead(200, { "content-type": "image/png" }).end(png);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await downloadImages([`http://127.0.0.1:${port}/a.png`])).toEqual([]);
      expect(hits).toEqual(["/a.png"]); // the redirect target was never requested
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("never reads more than the size limit: a declared oversize body is not read, an undeclared one stops early", async () => {
    // 50 MB in 1 MB pieces: far past the 4 MB limit, but finite, so a missing cap fails instead of hanging.
    const bigBody = () => {
      const seen = { pulls: 0 };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (seen.pulls >= 50) return controller.close();
          seen.pulls++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      return { body, seen };
    };
    const declared = bigBody();
    const declaredFetch = asFetch(
      async () =>
        new Response(declared.body, {
          headers: { "content-type": "image/png", "content-length": String(50 * 1024 * 1024) },
        }),
    );
    expect(await downloadImages(["https://media.discordapp.net/a.png"], declaredFetch)).toEqual([]);
    expect(declared.seen.pulls).toBeLessThanOrEqual(1);

    const undeclared = bigBody();
    const undeclaredFetch = asFetch(
      async () => new Response(undeclared.body, { headers: { "content-type": "image/png" } }),
    );
    expect(await downloadImages(["https://media.discordapp.net/a.png"], undeclaredFetch)).toEqual([]);
    expect(undeclared.seen.pulls).toBeLessThan(10);
  });
});

describe("sniffImageMime and imageDataUrl", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  it("recognise PNG and JPEG by their first bytes and nothing else, and make a data URL only of those", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    // Both leading bytes count, not either one.
    for (const almost of [
      [0xff, 0x00],
      [0x00, 0xd8],
      [0x89, 0x50, 0x4e, 0x00],
      [0x89, 0x00, 0x4e, 0x47],
      [0x00, 0x50, 0x4e, 0x47],
    ])
      expect(sniffImageMime(Buffer.from(almost)), almost.join()).toBeNull();
    expect(imageDataUrl(jpeg)).toBe("data:image/jpeg;base64,/9j/4A==");
    expect(imageDataUrl(Buffer.from("hello"))).toBeNull();
  });
});
