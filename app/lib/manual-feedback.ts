import type { ManualFeedbackEntry } from "./types";

export function createFeedback(reason: ManualFeedbackEntry["reason"], note: string): ManualFeedbackEntry {
  return {
    reason,
    note,
    createdAt: new Date().toISOString(),
  };
}

export function summarizeFeedback(entries: ManualFeedbackEntry[]): string {
  const counts = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
}
