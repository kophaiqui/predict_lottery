import { buildSeedSnapshot } from "./seed-data";
import { createDefaultPerformance } from "./prediction-engine";
import type { DashboardSnapshot, DrawRecord, PredictionRecord } from "./types";

const STORAGE_KEY = "predict_lottery_state_v1";
const listeners = new Set<() => void>();
const initialSnapshotCache = createSnapshotSeed();
let storageSnapshotCache: DashboardSnapshot = initialSnapshotCache;
let storageSnapshotRaw = "";

export function createInitialSnapshot(): DashboardSnapshot {
  return initialSnapshotCache;
}

function createSnapshotSeed(): DashboardSnapshot {
  const seed = buildSeedSnapshot();
  return {
    draws: seed.draws,
    predictions: [],
    performance: createDefaultPerformance(),
  };
}

export function loadSnapshot(): DashboardSnapshot {
  if (typeof window === "undefined") {
    return initialSnapshotCache;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialSnapshotCache;
    if (raw === storageSnapshotRaw) return storageSnapshotCache;
    const parsed = JSON.parse(raw) as Partial<DashboardSnapshot>;
    storageSnapshotRaw = raw;
    storageSnapshotCache = {
      draws: parsed.draws ?? createInitialSnapshot().draws,
      predictions: parsed.predictions ?? [],
      performance: parsed.performance ?? createDefaultPerformance(),
    };
    return storageSnapshotCache;
  } catch {
    return initialSnapshotCache;
  }
}

export function subscribeSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function saveSnapshot(snapshot: DashboardSnapshot): void {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(snapshot);
  storageSnapshotCache = snapshot;
  storageSnapshotRaw = raw;
  window.localStorage.setItem(STORAGE_KEY, raw);
  listeners.forEach((listener) => listener());
}

export function readSnapshotFromStorage(): DashboardSnapshot {
  return loadSnapshot();
}

export function writeSnapshotToStorage(snapshot: DashboardSnapshot): void {
  saveSnapshot(snapshot);
}

export function mergeDraws(existing: DrawRecord[], next: DrawRecord[]): { draws: DrawRecord[]; added: number; updated: number } {
  const byId = new Map(existing.map((draw) => [draw.drawId, draw]));
  let added = 0;
  let updated = 0;

  for (const draw of next) {
    if (byId.has(draw.drawId)) {
      const current = byId.get(draw.drawId);
      if (current && JSON.stringify(current) !== JSON.stringify(draw)) {
        byId.set(draw.drawId, draw);
        updated += 1;
      }
    } else {
      byId.set(draw.drawId, draw);
      added += 1;
    }
  }

  return {
    draws: Array.from(byId.values()).sort((a, b) => a.drawDate.localeCompare(b.drawDate)),
    added,
    updated,
  };
}

export function addPrediction(existing: PredictionRecord[], next: PredictionRecord): PredictionRecord[] {
  const filtered = existing.filter((item) => item.id !== next.id);
  return [next, ...filtered].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
