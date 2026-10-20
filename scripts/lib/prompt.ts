// The one terminal prompt the CLI still uses (`npm run destroy` asks you to type a word). Kept tiny: tests replace it.
import { createInterface } from "node:readline/promises";

/**
 * On a terminal, Ctrl-C at a prompt reaches the readline interface, not the process, so a process SIGINT handler (the
 * setup cleanup) would never run. This passes it on; if nothing handles it, the prompt closes and the process exits 130.
 */
export function forwardInterrupt(
  rl: { on(event: "SIGINT", listener: () => void): unknown; close(): void },
  host: { emit(signal: "SIGINT"): boolean; exit(code: number): void } = {
    emit: (signal) => process.emit(signal, signal),
    exit: (code) => process.exit(code),
  },
): void {
  rl.on("SIGINT", () => {
    if (host.emit("SIGINT")) return;
    rl.close();
    host.exit(130);
  });
}

/** Asks a question on the terminal and returns the typed line. */
export async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  forwardInterrupt(rl);
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
