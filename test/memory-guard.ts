// Ends a test worker whose memory passes the limit, so a runaway test (a fake stream that never ends, say) fails on
// its own instead of starving the machine. The check runs on its own thread: a promise loop can starve the worker's
// event loop, and timers on it would never fire. Memory outside the JavaScript heap (Buffers, ArrayBuffers) counts
// too, which --max-old-space-size would not catch. GORK_TEST_MEMORY_GB overrides the 4 GB limit.
import { Worker } from "node:worker_threads";

const flag = Symbol.for("gork.memoryGuard");
const g = globalThis as Record<symbol, unknown>;
if (!g[flag]) {
  g[flag] = true;
  const limit = Number(process.env.GORK_TEST_MEMORY_GB || 4) * 1024 ** 3;
  const watchdog = new Worker(
    `const { workerData: w } = require("node:worker_threads");
     setInterval(() => {
       if (process.memoryUsage.rss() > w.limit) {
         process._rawDebug("test worker passed " + w.limit / 1024 ** 3 + " GB of memory; ending it");
         process.kill(w.pid, "SIGKILL");
       }
     }, 200);`,
    { eval: true, workerData: { limit, pid: process.pid } },
  );
  watchdog.unref();
}
