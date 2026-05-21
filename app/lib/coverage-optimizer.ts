import type { DrawRecord, LotteryType, PredictionSet } from "./types";
import { average, round, seededRandom, sum } from "./number-utils";
import { LOTTERY_CONFIG } from "./lottery-config";

export interface CoverageProfile {
  lowCount: number;
  midCount: number;
  highCount: number;
  oddCount: number;
  evenCount: number;
  sumValue: number;
  overlapCount: number;
  coverageScore: number;
}

function band(number: number, maxNumber: number) {
  const third = Math.ceil(maxNumber / 3);
  if (number <= third) return "low";
  if (number <= third * 2) return "mid";
  return "high";
}

export function scoreCoverage(numbers: number[], history: DrawRecord[], lotteryType: LotteryType): CoverageProfile {
  const config = LOTTERY_CONFIG[lotteryType];
  const lows = numbers.filter((number) => band(number, config.maxNumber) === "low").length;
  const mids = numbers.filter((number) => band(number, config.maxNumber) === "mid").length;
  const highs = numbers.filter((number) => band(number, config.maxNumber) === "high").length;
  const odd = numbers.filter((number) => number % 2 === 1).length;
  const even = numbers.length - odd;
  const sumValue = sum(numbers);
  const overlapCount = history.length
    ? Math.max(...history.map((draw) => numbers.filter((number) => draw.numbers.includes(number)).length))
    : 0;
  const balanceScore =
    1 -
    (Math.abs(lows - mids) + Math.abs(mids - highs) + Math.abs(odd - even) + overlapCount) /
      Math.max(1, numbers.length * 4);

  return {
    lowCount: lows,
    midCount: mids,
    highCount: highs,
    oddCount: odd,
    evenCount: even,
    sumValue,
    overlapCount,
    coverageScore: round(Math.max(0, Math.min(1, balanceScore)), 3),
  };
}

export function isTooSimilar(candidate: number[], existing: PredictionSet[], maxOverlap = 3): boolean {
  return existing.some((set) => {
    const overlap = set.numbers.filter((number) => candidate.includes(number)).length;
    return overlap > maxOverlap;
  });
}

export function diversifyCandidates(params: {
  candidates: PredictionSet[];
  lotteryType: LotteryType;
  history: DrawRecord[];
  randomSeed?: number;
}): PredictionSet[] {
  const { candidates, lotteryType, history, randomSeed = Date.now() } = params;
  const random = seededRandom(randomSeed);
  const diversified: PredictionSet[] = [];

  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const profile = scoreCoverage(candidate.numbers, history, lotteryType);
    const tooSimilar = isTooSimilar(candidate.numbers, diversified, 3);
    const diversityBonus =
      profile.coverageScore * 0.5 +
      (1 - profile.overlapCount / Math.max(1, candidate.numbers.length)) * 0.3 +
      (0.2 + random() * 0.05);

    diversified.push({
      ...candidate,
      coverageScore: round(Math.min(1, diversityBonus), 3),
    });

    if (tooSimilar) {
      diversified[diversified.length - 1].coverageScore = round(
        Math.max(0, (diversified[diversified.length - 1].coverageScore ?? 0) - 0.15),
        3,
      );
    }
  }

  return diversified.sort((a, b) => (b.coverageScore ?? 0) - (a.coverageScore ?? 0));
}

export function summarizeCoverage(candidates: PredictionSet[]): string {
  if (!candidates.length) return "Chưa có bộ số.";
  const avgCoverage = average(candidates.map((candidate) => candidate.coverageScore ?? 0));
  return `Coverage trung bình: ${round(avgCoverage, 3)} trên ${candidates.length} bộ số.`;
}
