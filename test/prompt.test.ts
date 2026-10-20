import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { forwardInterrupt } from "../scripts/lib/prompt.ts";

function fakeReadline() {
  const rl = new EventEmitter() as EventEmitter & { close(): void; closed: boolean };
  rl.closed = false;
  rl.close = () => {
    rl.closed = true;
  };
  return rl;
}

describe("forwardInterrupt", () => {
  it("hands Ctrl-C at a prompt to the process-level SIGINT handlers", () => {
    const rl = fakeReadline();
    const emitted: string[] = [];
    const exits: number[] = [];
    forwardInterrupt(rl, {
      emit: (signal) => {
        emitted.push(signal);
        return true;
      },
      exit: (code) => exits.push(code),
    });
    rl.emit("SIGINT");
    expect(emitted).toEqual(["SIGINT"]);
    expect(exits).toEqual([]);
    expect(rl.closed).toBe(false);
  });

  it("closes the prompt and exits 130 itself when nothing handles the signal", () => {
    const rl = fakeReadline();
    const exits: number[] = [];
    forwardInterrupt(rl, { emit: () => false, exit: (code) => exits.push(code) });
    rl.emit("SIGINT");
    expect(rl.closed).toBe(true);
    expect(exits).toEqual([130]);
  });
});
