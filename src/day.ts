/** The UTC calendar date ("2026-10-19") of a moment, for the daily caps and the spend ledger. */
export const utcDay = (when: Date | number = Date.now()): string => new Date(when).toISOString().slice(0, 10);
