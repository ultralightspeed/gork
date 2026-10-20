import { describe, expect, it } from "vitest";
import { CF_MAX_BYTES, CfError, cfFetch, isFreeAllowanceExhausted, unwrapResult } from "../src/cf.ts";
import { fakeFetch, json, testConfig } from "./helpers.ts";

/** A body of `mb` one-megabyte pieces of spaces; it ends, so a missing cap fails the test instead of hanging. */
function megabytes(mb: number) {
  const seen = { pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!(seen.pulls < mb)) return controller.close();
      seen.pulls++;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
    },
  });
  return { body, seen };
}

describe("isFreeAllowanceExhausted", () => {
  it("is true for HTTP 429, whatever the body", () => {
    expect(isFreeAllowanceExhausted(new CfError(429, "slow down"))).toBe(true);
  });

  it("is true for error code 3036 in a parsed error body, whatever the status", () => {
    expect(
      isFreeAllowanceExhausted(new CfError(400, '{"errors":[{"code":3036,"message":"daily free allocation"}]}')),
    ).toBe(true);
  });

  it("is false when 3036 only appears as text, and for other errors", () => {
    expect(isFreeAllowanceExhausted(new CfError(500, '{"errors":[{"code":1000,"message":"ticket 3036"}]}'))).toBe(
      false,
    );
    expect(isFreeAllowanceExhausted(new CfError(500, "upstream 3036 timeout"))).toBe(false);
    expect(isFreeAllowanceExhausted(new CfError(403, '{"errors":[{"code":10000}]}'))).toBe(false);
    expect(isFreeAllowanceExhausted(new Error("3036"))).toBe(false);
  });
});

describe("unwrapResult", () => {
  it("returns the inside of a { result } envelope, and an unwrapped body as it is", () => {
    expect(unwrapResult({ success: true, result: { answers: 1 } })).toEqual({ answers: 1 });
    expect(unwrapResult({ choices: [] })).toEqual({ choices: [] });
  });
});

describe("cfFetch body cap", () => {
  const cfg = testConfig();

  it("stops reading a response that passes its cap", async () => {
    const { body, seen } = megabytes(10);
    const { f } = fakeFetch(() => new Response(body));
    await expect(cfFetch(cfg, "/ai/run/m", {}, f, 15_000, { maxBytes: 2 * 1024 * 1024 })).rejects.toThrow(
      /larger than 2 MB/,
    );
    expect(seen.pulls).toBeLessThan(5);
  });

  it("caps a response at CF_MAX_BYTES by default", async () => {
    const { body } = megabytes(CF_MAX_BYTES / (1024 * 1024) + 1);
    const { f } = fakeFetch(() => new Response(body, { status: 500 }));
    await expect(cfFetch(cfg, "/ai/run/m", {}, f)).rejects.toThrow(/larger than/);
  });
});

describe("cf errors", () => {
  it("keep the runtime token out of the error, and clip the body in the message (it is logged and shown)", async () => {
    const cfg = testConfig({ CF_RUN_TOKEN: "run-token-abc123" });
    const { f } = fakeFetch(() => json({ errors: [{ code: 10000, message: "x".repeat(5000) }] }, 403));
    const err: any = await cfFetch(cfg, "/ai/run/m", {}, f).catch((e) => e);
    expect(err).toBeInstanceOf(CfError);
    expect(err.status).toBe(403);
    expect(err.message.length).toBeLessThan(300);
    expect(JSON.stringify(err)).not.toContain("run-token-abc123");
    expect(String(err.stack)).not.toContain("run-token-abc123");
  });
});
