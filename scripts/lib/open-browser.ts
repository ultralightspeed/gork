// Opens the setup page in the default browser. Only ever given the exact address setup printed (a local address with a
// hex token), checked again here, because on Windows the address passes through cmd's parser and a stray & or " in it
// would run something else. It goes in as its own argument, never inside a shell string. The opener's command line can
// be read by other processes, which is why the token in it is good only for being swapped once for a cookie (see
// setup-server.ts).
import { execFile as realExecFile } from "node:child_process";

interface OpenDeps {
  platform: NodeJS.Platform;
  execFile: (
    file: string,
    args: string[],
    opts: { windowsHide: boolean },
    done: (err: Error | null) => void,
  ) => unknown;
}

const SETUP_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/s\/[0-9a-f]{16,128}\/$/;

const real: OpenDeps = {
  platform: process.platform,
  execFile: (file, args, opts, done) => realExecFile(file, args, opts, (err) => done(err)),
};

/** True when the opener ran without error. False (never a throw) when it couldn't, so the caller can print the address. */
export function openBrowser(url: string, deps: OpenDeps = real): Promise<boolean> {
  if (!SETUP_URL.test(url)) return Promise.resolve(false);
  const [file, args] =
    deps.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : deps.platform === "darwin"
        ? ["open", [url]]
        : deps.platform === "linux"
          ? ["xdg-open", [url]]
          : [null, []];
  if (file === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      deps.execFile(file, args as string[], { windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}
