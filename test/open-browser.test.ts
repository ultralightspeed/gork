import { describe, expect, it } from "vitest";
import { openBrowser } from "../scripts/lib/open-browser.ts";

const URL_OK = `http://127.0.0.1:51234/s/${"ab12".repeat(16)}/`;

function fakeExec(fail = false) {
  const calls: { file: string; args: string[] }[] = [];
  const execFile = (file: string, args: string[], _opts: unknown, done: (err: Error | null) => void) => {
    calls.push({ file, args });
    done(fail ? new Error("no such program") : null);
  };
  return { calls, execFile };
}

describe("openBrowser", () => {
  it("on Windows runs start through cmd, with the address as a separate argument (no shell string)", async () => {
    const x = fakeExec();
    expect(await openBrowser(URL_OK, { platform: "win32", execFile: x.execFile })).toBe(true);
    expect(x.calls).toEqual([{ file: "cmd", args: ["/c", "start", "", URL_OK] }]);
  });

  it("on a Mac runs open, and on Linux runs xdg-open", async () => {
    const mac = fakeExec();
    expect(await openBrowser(URL_OK, { platform: "darwin", execFile: mac.execFile })).toBe(true);
    expect(mac.calls).toEqual([{ file: "open", args: [URL_OK] }]);
    const linux = fakeExec();
    expect(await openBrowser(URL_OK, { platform: "linux", execFile: linux.execFile })).toBe(true);
    expect(linux.calls).toEqual([{ file: "xdg-open", args: [URL_OK] }]);
  });

  it("says false, rather than throwing, when the program isn't there, can't be started, or the platform is unknown", async () => {
    expect(await openBrowser(URL_OK, { platform: "linux", execFile: fakeExec(true).execFile })).toBe(false);
    const cantStart = () => {
      throw new Error("spawn failed");
    };
    expect(await openBrowser(URL_OK, { platform: "linux", execFile: cantStart })).toBe(false);
    const x = fakeExec();
    expect(await openBrowser(URL_OK, { platform: "aix", execFile: x.execFile })).toBe(false);
    expect(x.calls).toEqual([]);
  });

  it("refuses any address that isn't exactly our local setup address, so nothing can reach cmd's parser", async () => {
    const bad = [
      `&calc ${URL_OK}`,
      `x${URL_OK}`,
      `${URL_OK}&calc`,
      `${URL_OK}"`,
      `${URL_OK} x`,
      `${URL_OK}|whoami`,
      `${URL_OK}^`,
      `${URL_OK}%PATH%`,
      `${URL_OK}\n`,
      "https://example.com/",
      `http://localhost:51234/s/${"ab".repeat(32)}/`,
      `http://127.0.0.1.evil.example:1/s/${"ab".repeat(32)}/`,
      `http://127.0.0.1:51234/s/${"AB".repeat(32)}/`,
      `http://127.0.0.1:51234/s/${"ab".repeat(32)}/?x=1`,
      `http://user@127.0.0.1:51234/s/${"ab".repeat(32)}/`,
      "",
    ];
    for (const url of bad) {
      const x = fakeExec();
      expect(await openBrowser(url, { platform: "win32", execFile: x.execFile }), url).toBe(false);
      expect(x.calls, url).toEqual([]);
    }
  });
});
