import { LOTTERY_CONFIG } from "./lottery-config";
import { clamp, createId, round, seededRandom, uniqueSorted } from "./number-utils";
import { diversifyCandidates, scoreCoverage } from "./coverage-optimizer";
import { snapshotWeights } from "./model-versioning";
import { bumpAlgorithmVersion } from "./model-versioning";
import { evaluatePatterns, resolvePatternWeights } from "./patterns";
import { adjustWeightsFromPerformance, updatePatternPerformance } from "./pattern-performance";
import type {
  DrawRecord,
  ModelPerformance,
  PatternWeights,
  PredictionRecord,
  PredictionSet,
  LotteryType,
  ConfidenceLabel,
} from "./types";

export const PATTERN_NAMES = [
  "frequency",
  "cold",
  "recentTrend",
  "ratio",
  "structure",
  "pair",
  "movingAverage",
  "entropy",
  "monteCarlo",
] as const;

export interface EvaluatedPredictionSet extends PredictionSet {
  hits: number;
  confidence: ConfidenceLabel;
}

export function createDefaultPatternWeights(): PatternWeights {
  return {
    frequency: { enabled: true, weight: 78 },
    cold: { enabled: true, weight: 44 },
    recentTrend: { enabled: true, weight: 60 },
    ratio: { enabled: true, weight: 52 },
    structure: { enabled: true, weight: 46 },
    pair: { enabled: true, weight: 58 },
    movingAverage: { enabled: true, weight: 48 },
    entropy: { enabled: true, weight: 35 },
    monteCarlo: { enabled: true, weight: 24 },
  };
}

export function createDefaultPerformance(): ModelPerformance {
  return {
    weights: createDefaultPatternWeights(),
    patternStats: Object.fromEntries(
      PATTERN_NAMES.map((name) => [
        name,
        {
          usedCount: 0,
          avgMatch: 0,
          randomBaseline: 0,
          edge: 0,
          lastUpdated: new Date().toISOString(),
        },
      ]),
    ),
    learningRate: 0.04,
    lastUpdated: new Date().toISOString(),
    version: "1.0.0",
  };
}

function scoreNumber(
  candidate: number,
  numbersHistory: DrawRecord[],
  maxNumber: number,
  recentWindow: number,
): number {
  const recent = numbersHistory.slice(-recentWindow);
  const totalDraws = Math.max(1, numbersHistory.length);
  const frequencyCount = numbersHistory.reduce(
    (total, draw) => total + draw.numbers.filter((value) => value === candidate).length,
    0,
  );
  const recentCount = recent.reduce(
    (total, draw) => total + draw.numbers.filter((value) => value === candidate).length,
    0,
  );
  const lastSeenDistance = [...numbersHistory].reverse().findIndex((draw) => draw.numbers.includes(candidate));
  const coldFactor = lastSeenDistance < 0 ? 1 : clamp(lastSeenDistance / totalDraws, 0, 1);
  const frequencyFactor = frequencyCount / totalDraws;
  const recentFactor = recentCount / Math.max(1, recent.length);
  const centerBias = 1 - Math.abs(candidate - (maxNumber + 1) / 2) / maxNumber;

  return frequencyFactor * 0.38 + recentFactor * 0.28 + coldFactor * 0.18 + centerBias * 0.16;
}

function weightedPickNumbers(
  lotteryType: LotteryType,
  history: DrawRecord[],
  random: () => number,
  recentWindow = 6,
): number[] {
  const config = LOTTERY_CONFIG[lotteryType];
  const candidates = Array.from({ length: config.maxNumber }, (_, index) => index + 1);
  const picked = new Set<number>();

  while (picked.size < config.pickCount) {
    const scored = candidates
      .filter((number) => !picked.has(number))
      .map((number) => ({
        number,
        score: scoreNumber(number, history, config.maxNumber, recentWindow),
      }))
      .sort((a, b) => b.score - a.score);

    const topBand = scored.slice(0, Math.max(3, Math.ceil(scored.length * 0.25)));
    const selectionPool = topBand.length ? topBand : scored;
    const randomIndex = Math.floor(random() * selectionPool.length);
    const chosen = selectionPool[randomIndex]?.number ?? scored[0]?.number ?? 1;
    picked.add(chosen);
  }

  return uniqueSorted([...picked]);
}

function scoreSet(
  numbers: number[],
  history: DrawRecord[],
  weights: PatternWeights,
  lotteryType: LotteryType,
  maxNumber: number,
): PredictionSet {
  const patternSignals = evaluatePatterns(numbers, history, maxNumber);
  const normalizedWeights = resolvePatternWeights(weights);

  const patternBreakdown: Record<string, number> = {};
  const modelWeights: Record<string, number> = {};
  let totalWeight = 0;
  let weightedSum = 0;

  for (const signal of patternSignals) {
    const weight = normalizedWeights[signal.name]?.enabled ? normalizedWeights[signal.name].weight : 0;
    modelWeights[signal.name] = weight;
    patternBreakdown[signal.name] = round(signal.score, 3);
    totalWeight += weight;
    weightedSum += signal.score * weight;
  }

  const score = totalWeight > 0 ? round(weightedSum / totalWeight, 3) : 0;
  const coverageScore = scoreCoverage(numbers, history, lotteryType).coverageScore;
  const reasons = patternSignals
    .filter((signal) => signal.enabled && signal.score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((signal) => signal.explanation);

  return {
    numbers,
    score,
    coverageScore,
    patternBreakdown,
    modelWeights,
    reasons,
  };
}

export function generatePredictions(params: {
  lotteryType: LotteryType;
  history: DrawRecord[];
  count: number;
  performance: ModelPerformance;
  targetDrawDate: string;
}): PredictionRecord {
  const { lotteryType, history, count, performance, targetDrawDate } = params;
  const random = seededRandom(history.length + count * 991);
  const config = LOTTERY_CONFIG[lotteryType];
  const sets: PredictionSet[] = [];
  const seen = new Set<string>();

  while (sets.length < count) {
    const numbers = weightedPickNumbers(lotteryType, history, random);
    const signature = numbers.join("-");
    if (seen.has(signature)) continue;
    seen.add(signature);
    sets.push(scoreSet(numbers, history, performance.weights, lotteryType, config.maxNumber));
  }

  const diversified = diversifyCandidates({
    candidates: sets,
    lotteryType,
    history,
    randomSeed: history.length + count * 311,
  });

  return {
    id: createId("pred", targetDrawDate, lotteryType),
    lotteryType,
    targetDrawDate,
    generatedAt: new Date().toISOString(),
    modelVersion: performance.version ?? "1.0.0",
    algorithmVersion: "2.0.0",
    weightsSnapshot: snapshotWeights(performance.weights),
    configSnapshot: LOTTERY_CONFIG[lotteryType],
    predictedSets: diversified,
    status: "pending",
    actualResult: null,
    accuracy: null,
  };
}

export function confidenceFromScore(score: number): ConfidenceLabel {
  if (score >= 0.75) return "High";
  if (score >= 0.55) return "Medium";
  return "Low";
}

export function comparePredictionToActual(prediction: PredictionRecord, actual: number[]) {
  const actualSet = new Set(actual);
  const evaluated = prediction.predictedSets.map((candidate) => {
    const hits = candidate.numbers.filter((number) => actualSet.has(number)).length;
    return {
      ...candidate,
      hits,
      confidence: confidenceFromScore(candidate.score),
    };
  });

  const best = evaluated[0] ?? null;
  const accuracy = best
    ? round(best.hits / Math.max(1, actual.length), 3)
    : 0;

  return {
    ...prediction,
    predictedSets: evaluated,
    status: "checked" as const,
    actualResult: actual,
    accuracy,
  };
}

export function updatePerformance(
  performance: ModelPerformance,
  evaluatedPrediction: PredictionRecord,
): ModelPerformance {
  const best = evaluatedPrediction.predictedSets[0] as EvaluatedPredictionSet | undefined;
  const nextStats = updatePatternPerformance({
    current: performance.patternStats,
    patternBreakdown: best?.patternBreakdown ?? {},
    randomBaseline: 0.5,
  });
  const nextWeights = adjustWeightsFromPerformance({
    weights: resolvePatternWeights(performance.weights),
    performance: nextStats,
    learningRate: performance.learningRate,
  });

  return {
    ...performance,
    weights: nextWeights,
    patternStats: nextStats,
    lastUpdated: new Date().toISOString(),
    version: bumpAlgorithmVersion(performance.version ?? "1.0.0"),
  };
}
