import type { DashboardSnapshot, ModelVersionSnapshot, PatternWeights } from "./types";
import { LOTTERY_CONFIG } from "./lottery-config";

function incrementVersion(version: string): string {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    return "1.0.0";
  }
  parts[2] += 1;
  return parts.join(".");
}

export function createModelVersionSnapshot(params: {
  snapshot: DashboardSnapshot;
  lotteryType: keyof typeof LOTTERY_CONFIG;
  algorithmVersion?: string;
}): ModelVersionSnapshot {
  const { snapshot, lotteryType, algorithmVersion = "1.0.0" } = params;
  const modelVersion = snapshot.performance.version
    ? incrementVersion(snapshot.performance.version)
    : "1.0.0";

  return {
    modelVersion,
    algorithmVersion,
    weightsSnapshot: snapshot.performance.weights,
    configSnapshot: LOTTERY_CONFIG[lotteryType],
    generatedAt: new Date().toISOString(),
  };
}

export function bumpAlgorithmVersion(currentVersion: string): string {
  return incrementVersion(currentVersion);
}

export function snapshotWeights(weights: PatternWeights): PatternWeights {
  return JSON.parse(JSON.stringify(weights)) as PatternWeights;
}
