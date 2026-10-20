import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildLike, SpawnFn } from "../src/ffmpeg.ts";

/** A child process stand-in: the test drives its stdout/stderr and decides when it exits. */
export function fakeChild() {
  const child = new EventEmitter() as EventEmitter &
    Pick<ChildLike, "kill"> & { stdout: PassThrough; stderr: PassThrough; killed: boolean };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("close", null);
    return true;
  };
  return child;
}

/** Ends the child's output streams, then reports the exit, as a real process does. */
export function exit(child: ReturnType<typeof fakeChild>, code: number) {
  child.stdout.end();
  child.stderr.end();
  setImmediate(() => child.emit("close", code));
}

export function fakeSpawn(script: (child: ReturnType<typeof fakeChild>, args: string[]) => void) {
  const calls: { cmd: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const spawnFn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const child = fakeChild();
    children.push(child);
    queueMicrotask(() => script(child, args));
    return child;
  };
  return { spawnFn, calls, children };
}
