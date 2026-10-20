import { describe, expect, it } from "vitest";
import { splitCsv } from "../src/csv.ts";

describe("splitCsv", () => {
  it("trims each item, drops empty ones, and gives nothing for blank text", () => {
    expect(splitCsv(" a, b,, c ,")).toEqual(["a", "b", "c"]);
    expect(splitCsv("")).toEqual([]);
    expect(splitCsv(" , ")).toEqual([]);
  });
});
