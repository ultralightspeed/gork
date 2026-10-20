/** Splits a comma-separated setting, trimming each item and dropping empty ones. */
export const splitCsv = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
