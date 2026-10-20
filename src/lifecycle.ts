type Watchdog = {
  /** Starts the clock, counting as disconnected until the first markUp(). */
  start(): void;
  markDown(): void;
  markUp(): void;
  /** Disarms it for good. */
  stop(): void;
};

/** Calls `onExpire` if the connection stays down for `limitMs`; discord.js reconnects on its own until then. */
export function createWatchdog(opts: {
  limitMs: number;
  onExpire: () => void;
  checkMs?: number;
  now?: () => number;
}): Watchdog {
  const { limitMs, onExpire, checkMs = 30_000, now = Date.now } = opts;
  let downSince: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return {
    start() {
      downSince = now();
      timer ??= setInterval(() => {
        if (downSince === null || now() - downSince <= limitMs) return;
        stop();
        onExpire();
      }, checkMs).unref();
    },
    markDown() {
      downSince ??= now();
    },
    markUp() {
      downSince = null;
    },
    stop,
  };
}

const idleForever = () => {
  setInterval(() => {}, 1 << 30);
};

/**
 * Stops for good on errors a restart can't fix (bad config, unwritable data dir, rejected token or intents).
 * Prints one stable "[gork] FATAL <code>" line for the CLI to find, then idles instead of exiting, so Docker's
 * restart policy doesn't loop (each Discord login counts against a daily limit that resets the token when exceeded).
 * Stops the watchdog first: it would otherwise exit the idle process and Docker would restart into the same error.
 */
export function createFatal(
  watchdog: Pick<Watchdog, "stop">,
  io: { error: (line: string) => void; idle: () => void } = { error: console.error, idle: idleForever },
): (code: string, detail: string) => void {
  return (code, detail) => {
    watchdog.stop();
    io.error(`[gork] FATAL ${code}: ${detail}`);
    io.idle();
  };
}
