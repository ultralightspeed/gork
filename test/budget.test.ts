import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "gork-")), "ledger.json");

describe("Budget", () => {
  it("counts what is reserved and what is spent against the cap, and rejects overshoot", () => {
    const b = new Budget(file(), 0.01);
    expect(b.tryReserve(0.006)).toBe(true);
    expect(b.tryReserve(0.006)).toBe(false); // concurrent reservations count
    b.commit(0.006, 0.006);
    expect(b.tryReserve(0.006)).toBe(false); // spending counts
    expect(b.tryReserve(0.004)).toBe(true);
  });

  it("commit replaces the reservation with the actual cost, freeing the difference, and persists", () => {
    const f = file();
    const b = new Budget(f, 0.01);
    b.tryReserve(0.009);
    b.commit(0.009, 0.001);
    expect(b.spentToday).toBeCloseTo(0.001);
    expect(b.tryReserve(0.008)).toBe(true);
    expect(new Budget(f, 0.01).spentToday).toBeCloseTo(0.001);
  });

  it("resets on a new UTC day", () => {
    const f = file();
    let now = new Date("2026-10-13T23:59:00Z");
    const b = new Budget(f, 1, () => now);
    b.tryReserve(0.2);
    b.commit(0.2, 0.2);
    now = new Date("2026-10-14T00:00:01Z");
    expect(b.spentToday).toBe(0);
    expect(b.tryReserve(0.9)).toBe(true);
  });

  it("starts at $0 and warns once when the ledger file is corrupt", () => {
    const f = file();
    writeFileSync(f, "{not json");
    const warnings: string[] = [];
    expect(new Budget(f, 1, undefined, (line) => warnings.push(line)).spentToday).toBe(0);
    expect(warnings).toEqual(["ledger unreadable, starting today at $0"]);
  });
});
