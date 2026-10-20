import { describe, expect, it } from "vitest";
import { readCapped } from "../src/http.ts";

/** A body of `chunks` pieces of `size` bytes that counts how many pieces were pulled and whether it was cancelled. */
function counted(chunks: number, size: number) {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulls >= chunks) return controller.close();
      seen.pulls++;
      controller.enqueue(new Uint8Array(size).fill(65));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

describe("readCapped", () => {
  it("returns a body that fits, up to exactly the cap, and an empty one for no body", async () => {
    expect((await readCapped(new Response("hello"), 10))?.toString()).toBe("hello");
    expect((await readCapped(new Response("12345"), 5))?.length).toBe(5);
    expect(await readCapped(new Response("123456"), 5)).toBeNull();
    expect((await readCapped(new Response(null), 10))?.length).toBe(0);
    const declaredAtCap = new Response("12345", { headers: { "content-length": "5" } });
    expect((await readCapped(declaredAtCap, 5))?.length).toBe(5);
  });

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const { body, seen } = counted(100, 1024);
    const res = new Response(body, { headers: { "content-length": String(100 * 1024) } });
    expect(await readCapped(res, 4096)).toBeNull();
    expect(seen.pulls).toBeLessThanOrEqual(1);
  });

  it("stops reading and cancels as soon as an undeclared body passes the cap", async () => {
    const { body, seen } = counted(1000, 1024);
    expect(await readCapped(new Response(body), 4096)).toBeNull();
    expect(seen.pulls).toBeLessThan(10);
    expect(seen.cancelled).toBe(true);
  });
});
