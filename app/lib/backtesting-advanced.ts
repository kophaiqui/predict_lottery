import { evaluatePrizeTier } from "./prize-rules";
import { average, round, seededRandom } from "./number-utils";
import { comparePredictionToActual, generatePredictions } from "./prediction-engine";
import type {
  BacktestRow,
  DrawRecord,
  LotteryType,
  ModelPerformance,
  RollingBacktestResult,
  PatternPerformanceMap,
  BacktestResult,
} from "./types";
import { updatePatternPerformance } from "./pattern-performance";

function buildBaselineSet(maxNumber: number, pickCount: number, random: () => number) {
  const pool = Array.from({ length: maxNumber }, (_, index) => index + 1);
  const selected = new Set<number>();
  while (selected.size < pickCount) {
    const next = pool[Math.floor(random() * pool.length)] ?? 1;
    selected.add(next);
  }
  return Array.from(selected).sort((a, b) => a - b);
}

export function runRollingBacktest(params: {
  lotteryType: LotteryType;
  draws: DrawRecord[];
  performance: ModelPerformance;
  trainWindow: number;
  testWindow?: number;
}): RollingBacktestResult {
  const { lotteryType, draws, performance, trainWindow, testWindow = draws.length } = params;
  const sorted = [...draws]
    .filter((draw) => draw.lotteryType === lotteryType)
    .sort((a, b) => a.drawDate.localeCompare(b.drawDate));
  const rows: BacktestRow[] = [];
  const hitDistribution: Record<string, number> = {};
  const patternTotals: Record<string, number> = {};
  const patternPerformance: PatternPerformanceMap = {};
  const randomMatches: number[] = [];
  const modelMatches: number[] = [];
  const warnings: string[] = [];
  const startedAt = Math.max(trainWindow, 1);
  const limit = Math.min(sorted.length, startedAt + testWindow);

  for (let index = startedAt; index < limit; index += 1) {
    const history = sorted.slice(Math.max(0, index - trainWindow), index);
    const actual = sorted[index];
    if (!actual || history.length < trainWindow) continue;

    const prediction = generatePredictions({
      lotteryType,
      history,
      count: 1,
      performance,
      targetDrawDate: actual.drawDate,
    });
    const evaluated = comparePredictionToActual(prediction, actual.numbers);
    const best = evaluated.predictedSets[0];
    const modelHit = best?.hits ?? 0;
    const random = seededRandom(index * 997 + trainWindow * 13);
    const baselineSet = buildBaselineSet(actual.numbers.length ? Math.max(...actual.numbers) + 5 : 55, actual.numbers.length, random);
    const baselineHit = baselineSet.filter((number) => actual.numbers.includes(number)).length;
    const prize = evaluatePrizeTier({
      lotteryType,
      predictedNumbers: best?.numbers ?? [],
      actualDraw: actual,
    });

    modelMatches.push(modelHit);
    randomMatches.push(baselineHit);
    hitDistribution[String(modelHit)] = (hitDistribution[String(modelHit)] ?? 0) + 1;

    if (best) {
      for (const [name, value] of Object.entries(best.patternBreakdown)) {
        patternTotals[name] = (patternTotals[name] ?? 0) + value;
      }
      Object.assign(
        patternPerformance,
        updatePatternPerformance({
          current: patternPerformance,
          patternBreakdown: best.patternBreakdown,
          randomBaseline: baselineHit / Math.max(1, actual.numbers.length),
        }),
      );
    }

    rows.push({
      drawDate: actual.drawDate,
      predicted: best ? best.numbers.join(" - ") : "-",
      actual: actual.numbers.join(" - "),
      hits: modelHit,
      score: best?.score ?? 0,
      confidence: prize.isWinning ? "High" : best && best.score >= 0.55 ? "Medium" : "Low",
    });
  }

  const modelAverageMatch = rows.length ? round(average(modelMatches), 3) : 0;
  const randomAverageMatch = rows.length ? round(average(randomMatches), 3) : 0;
  const edge = round(modelAverageMatch - randomAverageMatch, 3);
  if (edge <= 0) {
    warnings.push("Model không vượt random baseline trong phạm vi backtest này.");
  }

  const bestPatternNames = Object.entries(patternTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name]) => name);

  const base: BacktestResult = {
    params: {
      lotteryType,
      trainWindow,
      testWindow: limit - startedAt,
      fromDate: sorted[0]?.drawDate ?? new Date().toISOString().slice(0, 10),
      toDate: sorted[limit - 1]?.drawDate ?? sorted[0]?.drawDate ?? new Date().toISOString().slice(0, 10),
    },
    rows,
    hitDistribution,
    averageHits: modelAverageMatch,
    bestPatternNames,
    summary:
      rows.length > 0
        ? `Rolling backtest ${rows.length} kỳ, modelAvg ${modelAverageMatch}, randomAvg ${randomAverageMatch}.`
        : "Không đủ dữ liệu để rolling backtest.",
  };

  return {
    ...base,
    modelAverageMatch,
    randomAverageMatch,
    edge,
    warnings,
  };
}

export function summarizeRollingBacktest(result: RollingBacktestResult): string {
  return `${result.summary} Edge: ${result.edge}. ${result.warnings.join(" ")}`.trim();
}
