import { average, formatDisplayDate, round } from "./number-utils";
import { confidenceFromScore, comparePredictionToActual, generatePredictions } from "./prediction-engine";
import type {
  BacktestResult,
  DrawRecord,
  ModelPerformance,
  LotteryType,
} from "./types";

function filterWindow(draws: DrawRecord[], fromDate: string, toDate: string): DrawRecord[] {
  return draws.filter((draw) => draw.drawDate >= fromDate && draw.drawDate <= toDate);
}

export function runBacktest(params: {
  lotteryType: LotteryType;
  draws: DrawRecord[];
  performance: ModelPerformance;
  trainWindow: number;
  testWindow: number;
  fromDate: string;
  toDate: string;
}): BacktestResult {
  const { lotteryType, draws, performance, trainWindow, testWindow, fromDate, toDate } = params;
  const filtered = filterWindow(draws, fromDate, toDate).filter((draw) => draw.lotteryType === lotteryType);
  const rows = [];
  const hitDistribution: Record<string, number> = {};
  const patternTotals: Record<string, number> = {};

  for (let index = trainWindow; index < Math.min(filtered.length, trainWindow + testWindow); index += 1) {
    const history = filtered.slice(Math.max(0, index - trainWindow), index);
    const actual = filtered[index];
    if (!actual) continue;

    const prediction = generatePredictions({
      lotteryType,
      history,
      count: 1,
      performance,
      targetDrawDate: actual.drawDate,
    });
    const evaluated = comparePredictionToActual(prediction, actual.numbers);
    const best = evaluated.predictedSets[0];
    const hits = best?.hits ?? 0;

    hitDistribution[String(hits)] = (hitDistribution[String(hits)] ?? 0) + 1;
    if (best) {
      for (const [name, value] of Object.entries(best.patternBreakdown)) {
        patternTotals[name] = (patternTotals[name] ?? 0) + value;
      }
    }

    rows.push({
      drawDate: actual.drawDate,
      predicted: best ? best.numbers.join(" - ") : "-",
      actual: actual.numbers.join(" - "),
      hits,
      score: best?.score ?? 0,
      confidence: confidenceFromScore(best?.score ?? 0),
    });
  }

  const averageHits = rows.length ? round(average(rows.map((row) => row.hits)), 3) : 0;
  const bestPatternNames = Object.entries(patternTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name]) => name);

  return {
    params: { lotteryType, trainWindow, testWindow, fromDate, toDate },
    rows,
    hitDistribution,
    averageHits,
    bestPatternNames,
    summary:
      rows.length > 0
        ? `Đã backtest ${rows.length} kỳ, trung bình ${averageHits} số trùng mỗi bộ.`
        : "Không đủ dữ liệu để backtest trong phạm vi đã chọn.",
  };
}

export function summarizeBacktest(result: BacktestResult): string {
  return [
    result.summary,
    `Phạm vi: ${formatDisplayDate(result.params.fromDate)} đến ${formatDisplayDate(result.params.toDate)}.`,
    `Pattern nổi bật: ${result.bestPatternNames.join(", ") || "chưa có dữ liệu"}.`,
  ].join(" ");
}
