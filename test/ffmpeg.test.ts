import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  audioArgs,
  caBundle,
  FfmpegError,
  frameArgs,
  Gate,
  hasAudioStream,
  inputArgs,
  MAX_FRAMES_PER_SECOND,
  pickEvenly,
  runFfmpeg,
  splitJpegs,
  windowInputArgs,
} from "../src/ffmpeg.ts";
import { exit, fakeSpawn } from "./fake-ffmpeg.ts";

const jpeg = (...body: number[]) => Buffer.from([0xff, 0xd8, ...body, 0xff, 0xd9]);

const url = "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=a&is=b&hm=c";
const at = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

// ffmpeg reads hostile media from the network, so both ways of building its input arguments carry the same limits.
describe.each([
  ["inputArgs", () => inputArgs(url, 60)],
  ["windowInputArgs", () => windowInputArgs(url, 12, 16)],
])("%s", (_name, build) => {
  const args = build();

  it("ends with the URL as one argv entry after -i, with every option before it", () => {
    expect(args.slice(-2)).toEqual(["-i", url]);
  });

  it("only fetches over https, verifies the certificate and follows no redirect", () => {
    expect(at(args, "-protocol_whitelist")).toBe("https,tls,tcp");
    expect(at(args, "-tls_verify")).toBe("1");
    expect(at(args, "-ca_file")).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(at(args, "-max_redirects")).toBe("0");
  });

  it("caps any one allocation, parses only video containers, never reads stdin and uses one thread", () => {
    expect(at(args, "-max_alloc")).toBe(String(16 * 1024 * 1024)); // a tiny file can claim a huge frame size
    const demuxers = at(args, "-format_whitelist").split(",");
    expect(demuxers).toEqual(expect.arrayContaining(["mp4", "mov", "matroska", "webm"]));
    for (const bad of ["hls", "concat", "mpegts", "image2", "data"]) expect(demuxers).not.toContain(bad);
    expect(args).toContain("-nostdin");
    expect(at(args, "-threads")).toBe("1");
  });
});

describe("inputArgs and windowInputArgs differ only in how much they read", () => {
  // Remove each flag in `flags` together with its value; what is left is the shared hardening.
  const without = (a: string[], flags: string[]) => a.filter((x, i) => !flags.includes(x) && !flags.includes(a[i - 1]));

  it("stops at the duration cap, before -i", () => {
    const a = inputArgs(url, 60);
    expect(at(a, "-t")).toBe("60");
    expect(a.indexOf("-t")).toBeLessThan(a.indexOf("-i"));
  });

  it("seeks with -ss and -to before -i, and drops -t, which ffmpeg would let beat -to", () => {
    const win = windowInputArgs(url, 12, 16);
    expect(at(win, "-ss")).toBe("12");
    expect(at(win, "-to")).toBe("16");
    expect(win.indexOf("-ss")).toBeLessThan(win.indexOf("-i"));
    expect(win.indexOf("-to")).toBeLessThan(win.indexOf("-i"));
    expect(win).not.toContain("-t");
    expect(without(win, ["-ss", "-to"])).toEqual(without(inputArgs(url, 60), ["-t"]));
  });

  it("only takes whole, non-negative seconds with to after from, so nothing odd reaches argv", () => {
    for (const [from, to] of [
      [Number.NaN, 5],
      [0, Number.NaN],
      [0, Number.POSITIVE_INFINITY],
      [-1, 5],
      [3, 3],
      [5, 3],
      [0.5, 3],
      [1, 2.5],
      [1e-7, 3],
    ])
      expect(() => windowInputArgs(url, from, to), `${from}-${to}`).toThrow(RangeError);
    expect(() => windowInputArgs(url, 0, 1)).not.toThrow(); // the start of the clip is a fine place to begin
  });

  it("uses SSL_CERT_FILE for the certificate bundle when set (running outside the Docker image)", () => {
    expect(caBundle({})).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(caBundle({ SSL_CERT_FILE: "C:/certs/ca.pem" })).toBe("C:/certs/ca.pem");
    expect(at(inputArgs(url, 60, "C:/certs/ca.pem"), "-ca_file")).toBe("C:/certs/ca.pem");
    expect(at(windowInputArgs(url, 1, 2, "C:/certs/ca.pem"), "-ca_file")).toBe("C:/certs/ca.pem");
  });
});

describe("frameArgs", () => {
  it("refuses a rate that is not a whole number from 1 to MAX_FRAMES_PER_SECOND", () => {
    for (const n of [0, -1, 1.5, MAX_FRAMES_PER_SECOND + 1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => frameArgs(n), String(n)).toThrow(RangeError);
    for (const n of [1, MAX_FRAMES_PER_SECOND]) expect(() => frameArgs(n), String(n)).not.toThrow();
  });
});

describe("splitJpegs", () => {
  it("splits a concatenated MJPEG stream on SOI/EOI", () => {
    const frames = splitJpegs(Buffer.concat([jpeg(1, 2), jpeg(3), jpeg(4, 5, 6)]));
    expect(frames).toEqual([jpeg(1, 2), jpeg(3), jpeg(4, 5, 6)]);
  });

  it("drops a truncated last frame and leading junk, and returns nothing for marker-free input", () => {
    const cut = Buffer.concat([Buffer.from([9, 9]), jpeg(1), Buffer.from([0xff, 0xd8, 7, 7])]);
    expect(splitJpegs(cut)).toEqual([jpeg(1)]);
    expect(splitJpegs(Buffer.from([1, 2, 3]))).toEqual([]);
  });
});

describe("pickEvenly", () => {
  it("takes n items spread across the list, centered in their slots, or all of them when there are n or fewer", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(pickEvenly(items, 6).map((p) => p.index)).toEqual([2, 7, 12, 17, 22, 27]);
    expect(pickEvenly([10, 20, 30], 6)).toEqual([
      { item: 10, index: 0 },
      { item: 20, index: 1 },
      { item: 30, index: 2 },
    ]);
  });
});

describe("hasAudioStream", () => {
  it("reads ffmpeg's stream listing", () => {
    expect(hasAudioStream("  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, mono")).toBe(true);
    expect(hasAudioStream("  Stream #0:0[0x1](und): Video: h264, yuv420p")).toBe(false);
    expect(hasAudioStream("")).toBe(false);
  });
});

describe("runFfmpeg", () => {
  const limits = { timeoutMs: 1000, maxStdout: 1000 };

  it("collects stdout across chunks, even when a JPEG marker is cut in half", async () => {
    const whole = Buffer.concat([jpeg(1, 2), jpeg(3)]);
    const { spawnFn } = fakeSpawn((c) => {
      c.stdout.write(whole.subarray(0, 3)); // cuts the second marker pair of the first frame in half
      c.stdout.write(whole.subarray(3));
      c.stderr.write("Stream #0:1: Audio: aac");
      exit(c, 0);
    });
    const r = await runFfmpeg(["-i", "x"], { ...limits, spawnFn });
    expect(splitJpegs(r.stdout)).toEqual([jpeg(1, 2), jpeg(3)]);
    expect(r.stderr).toContain("Audio");
    expect(r.code).toBe(0);
  });

  it("runs ffmpeg with the given argv and no environment but PATH, so the bot's secrets never reach it", async () => {
    process.env.GORK_TEST_SECRET = "hunter2";
    try {
      const { spawnFn, calls } = fakeSpawn((c) => exit(c, 0));
      await runFfmpeg(["-i", "x"], { ...limits, spawnFn });
      expect(calls[0].cmd).toBe("ffmpeg");
      expect(calls[0].args).toEqual(["-i", "x"]);
      expect(calls[0].env).not.toHaveProperty("GORK_TEST_SECRET");
      expect(Object.keys(calls[0].env).filter((k) => !["PATH", "SystemRoot"].includes(k))).toEqual([]);
    } finally {
      delete process.env.GORK_TEST_SECRET;
    }
  });

  it("starts the program without a shell, so an argument (a URL) is never interpreted", async () => {
    const hostile = "a & echo injected $(echo y) | cat";
    const r = await runFfmpeg(["-p", "process.argv[1]", hostile], { ...limits, bin: process.execPath });
    expect(r.stdout.toString().trim()).toBe(hostile);
  });

  it("reports a non-zero exit with what it produced, for the caller to judge", async () => {
    const { spawnFn } = fakeSpawn((c) => {
      c.stdout.write(jpeg(1));
      exit(c, 1);
    });
    const r = await runFfmpeg([], { ...limits, spawnFn });
    expect(r.code).toBe(1);
    expect(splitJpegs(r.stdout)).toHaveLength(1);
  });

  it("kills the process and fails when output passes the byte cap", async () => {
    const { spawnFn, children } = fakeSpawn((c) => c.stdout.write(Buffer.alloc(2000)));
    const err = await runFfmpeg([], { ...limits, spawnFn }).catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.kind).toBe("too-big");
    expect(children[0].killed).toBe(true);
    // Output of exactly the cap is fine.
    const exact = fakeSpawn((c) => {
      c.stdout.write(Buffer.alloc(1000));
      exit(c, 0);
    });
    expect((await runFfmpeg([], { ...limits, spawnFn: exact.spawnFn })).stdout.length).toBe(1000);
  });

  it("kills the process and fails at the wall-clock limit", async () => {
    const { spawnFn, children } = fakeSpawn(() => {});
    const err = await runFfmpeg([], { timeoutMs: 20, maxStdout: 1000, spawnFn }).catch((e) => e);
    expect(err.kind).toBe("timeout");
    expect(children[0].killed).toBe(true);
  });

  it("waits for a killed ffmpeg to exit before failing, so the next one can't overlap it", async () => {
    let child: ReturnType<typeof fakeSpawn>["children"][number] | undefined;
    const { spawnFn } = fakeSpawn((c) => {
      child = c;
      c.kill = () => {
        c.killed = true;
        return true; // a real SIGKILL'd process reports "close" a moment later
      };
    });
    // Fake timers, so the 20 ms limit passes exactly when the test says (microtasks and setImmediate stay real).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const run = runFfmpeg([], { timeoutMs: 20, maxStdout: 1000, spawnFn }).catch((e) => {
        settled = true;
        return e;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(child?.killed).toBe(true);
      await vi.advanceTimersByTimeAsync(1000); // well inside the 5 s grace period
      expect(settled).toBe(false);
      child?.emit("close", null);
      expect((await run).kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up waiting for a killed ffmpeg after a grace period", async () => {
    const { spawnFn } = fakeSpawn((c) => {
      c.kill = () => true;
    });
    const err = await runFfmpeg([], { timeoutMs: 10, maxStdout: 1000, spawnFn, killGraceMs: 20 }).catch((e) => e);
    expect(err.kind).toBe("timeout");
  });

  it("says so when the ffmpeg binary is missing", async () => {
    const { spawnFn } = fakeSpawn((c) =>
      c.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })),
    );
    const err = await runFfmpeg([], { ...limits, spawnFn }).catch((e) => e);
    expect(err.kind).toBe("missing");
  });

  it("keeps only the start of a flood of stderr", async () => {
    const { spawnFn } = fakeSpawn((c) => {
      c.stderr.write("head ");
      c.stderr.write("x".repeat(500_000));
      exit(c, 0);
    });
    const r = await runFfmpeg([], { ...limits, spawnFn });
    expect(r.stderr.startsWith("head ")).toBe(true);
    expect(r.stderr.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("Gate", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("runs one job at a time, in order", async () => {
    const gate = new Gate(5);
    const log: string[] = [];
    const job = (name: string) => async () => {
      log.push(`start ${name}`);
      await tick();
      log.push(`end ${name}`);
      return name;
    };
    const out = await Promise.all([gate.run(job("a")), gate.run(job("b")), gate.run(job("c"))]);
    expect(out).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("turns away work when too many jobs are already waiting", async () => {
    const gate = new Gate(1);
    const slow = gate.run(tick); // running
    const waiting = gate.run(async () => "ok"); // the one allowed waiter
    const err = await gate.run(async () => "no").catch((e) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect(err.kind).toBe("busy");
    await Promise.all([slow, waiting]);
  });

  it("keeps going after a job fails", async () => {
    const gate = new Gate(2);
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await gate.run(async () => "fine")).toBe("fine");
  });
});

// Real ffmpeg against clips it generates itself (never a downloaded file). Skipped when ffmpeg isn't installed.
const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
describe.skipIf(!haveFfmpeg)("with a real ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "gork-ffmpeg-"));
  const make = (name: string, withAudio: boolean) => {
    const out = join(dir, name);
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=5:size=320x240:rate=10"];
    if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=5");
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
    if (withAudio) args.push("-c:a", "aac", "-shortest");
    args.push(out);
    expect(spawnSync("ffmpeg", args).status).toBe(0);
    return out;
  };
  // The production input args allow only https; a local file needs its own input args, but the same output args.
  const fileInput = (path: string) => ["-hide_banner", "-nostdin", "-nostats", "-threads", "1", "-t", "60", "-i", path];
  const limits = { timeoutMs: 20_000, maxStdout: 8 * 1024 * 1024 };

  it("pulls one JPEG per second, and finds the audio track and an MP3 of it", async () => {
    const clip = make("audio.mp4", true);
    const frames = await runFfmpeg([...fileInput(clip), ...frameArgs()], limits);
    expect(frames.code).toBe(0);
    const jpegs = splitJpegs(frames.stdout);
    expect(jpegs.length).toBeGreaterThanOrEqual(4);
    expect(jpegs.length).toBeLessThanOrEqual(6);
    expect(jpegs.every((j) => j[0] === 0xff && j[1] === 0xd8)).toBe(true);
    expect(hasAudioStream(frames.stderr)).toBe(true);
    const audio = await runFfmpeg([...fileInput(clip), ...audioArgs()], limits);
    expect(audio.code).toBe(0);
    expect(audio.stdout.length).toBeGreaterThan(1000);
  });

  it("reports a silent clip as having no audio, and still returns frames", async () => {
    const clip = make("silent.mp4", false);
    const frames = await runFfmpeg([...fileInput(clip), ...frameArgs()], limits);
    expect(splitJpegs(frames.stdout).length).toBeGreaterThanOrEqual(4);
    expect(hasAudioStream(frames.stderr)).toBe(false);
  });

  it("under the production input args a plain file is refused, and every other option parses (-ss, -to, fps)", async () => {
    const clip = make("again.mp4", false);
    for (const input of [inputArgs(clip, 60), windowInputArgs(clip, 1, 3)]) {
      const r = await runFfmpeg([...input.slice(0, -1), clip, ...frameArgs(2)], limits);
      expect(splitJpegs(r.stdout)).toEqual([]); // `file` is not in the production protocol whitelist
      // ...and that is the only complaint: every other production option was parsed by a real ffmpeg.
      expect(r.stderr).toMatch(/Protocol 'file' not on whitelist/);
      expect(r.stderr).not.toMatch(/unrecognized option|option .* not found/i);
    }
  });

  // The production window args, changed only where a local file needs it: `file` is allowed as a protocol, and the
  // options that belong to the https protocol (redirects, TLS) go, because ffmpeg rejects a protocol option nothing used.
  const fileWindow = (path: string, from: number, to: number) => {
    const a = windowInputArgs(path, from, to).slice(0, -1);
    a[a.indexOf("-protocol_whitelist") + 1] = "file";
    const httpsOnly = ["-max_redirects", "-tls_verify", "-ca_file"];
    return [...a.filter((x, i) => !httpsOnly.includes(x) && !httpsOnly.includes(a[i - 1])), path];
  };

  it("reads only the window, starting at its first second: 1 s to 3 s at 2 per second is about four frames", async () => {
    const clip = make("seek.mp4", false);
    const r = await runFfmpeg([...fileWindow(clip, 1, 3), ...frameArgs(2)], limits);
    expect(r.code).toBe(0);
    const n = splitJpegs(r.stdout).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(5);
    const whole = await runFfmpeg([...fileInput(clip), ...frameArgs(2)], limits);
    expect(splitJpegs(whole.stdout).length).toBeGreaterThanOrEqual(9); // 5 s at 2 per second
    // testsrc draws a running counter, so different seconds differ: the window starts where it says.
    const a = splitJpegs((await runFfmpeg([...fileWindow(clip, 2, 3), ...frameArgs(1)], limits)).stdout);
    const b = splitJpegs((await runFfmpeg([...fileWindow(clip, 4, 5), ...frameArgs(1)], limits)).stdout);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].equals(b[0])).toBe(false);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
