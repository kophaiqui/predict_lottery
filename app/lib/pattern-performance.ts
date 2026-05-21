import { round } from "./number-utils";
import type { PatternPerformanceMap, PatternWeights } from "./types";

export function updatePatternPerformance(params: {
  current: PatternPerformanceMap;
  patternBreakdown: Record<string, number>;
  randomBaseline: number;
}): PatternPerformanceMap {
  const { current, patternBreakdown, randomBaseline } = params;
  const next: PatternPerformanceMap = { ...current };

  for (const [name, match] of Object.entries(patternBreakdown)) {
    const existing = current[name] ?? {
      usedCount: 0,
      avgMatch: 0,
      randomBaseline,
      edge: 0,
      lastUpdated: new Date().toISOString(),
    };
    const usedCount = existing.usedCount + 1;
    const avgMatch = round((existing.avgMatch * existing.usedCount + match) / usedCount, 3);
    const edge = round(avgMatch - randomBaseline, 3);
    next[name] = {
      usedCount,
      avgMatch,
      randomBaseline,
      edge,
      lastUpdated: new Date().toISOString(),
    };
  }

  return next;
}

export function adjustWeightsFromPerformance(params: {
  weights: PatternWeights;
  performance: PatternPerformanceMap;
  learningRate: number;
  minWeight?: number;
  maxWeight?: number;
  maxWeightChangePerUpdate?: number;
}): PatternWeights {
  const {
    weights,
    performance,
    learningRate,
    minWeight = 0,
    maxWeight = 100,
    maxWeightChangePerUpdate = 6,
  } = params;

  const next: PatternWeights = {};
  for (const [name, value] of Object.entries(weights)) {
    const stat = performance[name];
    const edge = stat?.edge ?? 0;
    const delta = Math.max(
      -maxWeightChangePerUpdate,
      Math.min(maxWeightChangePerUpdate, edge * learningRate * 50),
    );
    next[name] = {
      enabled: value.enabled,
      weight: round(Math.max(minWeight, Math.min(maxWeight, value.weight + delta)), 2),
    };
  }
  return next;
}
