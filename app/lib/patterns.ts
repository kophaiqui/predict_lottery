import type { DrawRecord, PatternBreakdown, PatternSignal, PatternWeights } from "./types";
import { average, median, range, round, sum } from "./number-utils";

function frequencyScore(
  numbers: number[],
  history: DrawRecord[],
  maxNumber: number,
): PatternBreakdown {
  const counts = new Map<number, number>();
  for (const draw of history) {
    for (const number of draw.numbers) {
      counts.set(number, (counts.get(number) ?? 0) + 1);
    }
  }

  const result: PatternBreakdown = {};
  const frequencies = Array.from(counts.values());
  const maxFrequency = Math.max(1, ...frequencies);

  for (const number of numbers) {
    result[`frequency:${number}`] = round((counts.get(number) ?? 0) / maxFrequency, 3);
  }

  result.frequencyCoverage = round(
    numbers.filter((number) => (counts.get(number) ?? 0) > average(frequencies)).length /
      Math.max(1, numbers.length),
    3,
  );
  result.frequencyBalance = round(1 - Math.abs(average(numbers) - (maxNumber + 1) / 2) / maxNumber, 3);
  return result;
}

function coldScore(numbers: number[], history: DrawRecord[], maxNumber: number): PatternBreakdown {
  const lastSeen = new Map<number, number>();
  history.forEach((draw, index) => {
    draw.numbers.forEach((number) => {
      lastSeen.set(number, index);
    });
  });
  const latestIndex = history.length - 1;

  return numbers.reduce<PatternBreakdown>((acc, number) => {
    const distance = latestIndex - (lastSeen.get(number) ?? -1);
    acc[`cold:${number}`] = round(Math.min(1, distance / Math.max(1, history.length)), 3);
    acc.coldMean = round(
      sum(numbers.map((value) => latestIndex - (lastSeen.get(value) ?? -1))) /
        Math.max(1, numbers.length * maxNumber),
      3,
    );
    return acc;
  }, {});
}

function recentTrendScore(numbers: number[], history: DrawRecord[]): PatternBreakdown {
  const recent = history.slice(-5);
  const set = new Set(recent.flatMap((draw) => draw.numbers));
  const hitRate = numbers.filter((number) => set.has(number)).length / Math.max(1, numbers.length);
  return {
    recentTrend: round(hitRate, 3),
    recentMomentum: round(recent.length ? recent.some((draw) => draw.numbers.some((value) => numbers.includes(value))) ? 1 : 0 : 0, 3),
  };
}

function ratioScore(numbers: number[], maxNumber: number): PatternBreakdown {
  const odd = numbers.filter((number) => number % 2 === 1).length;
  const even = numbers.length - odd;
  const low = numbers.filter((number) => number <= Math.ceil(maxNumber / 2)).length;
  const high = numbers.length - low;
  const sumValue = sum(numbers);

  return {
    oddEvenBalance: round(1 - Math.abs(odd - even) / Math.max(1, numbers.length), 3),
    lowHighBalance: round(1 - Math.abs(low - high) / Math.max(1, numbers.length), 3),
    sumRangeFit: round(1 - Math.abs(sumValue / Math.max(1, numbers.length) - (maxNumber + 1) / 2) / maxNumber, 3),
  };
}

function structuralScore(numbers: number[]): PatternBreakdown {
  const ordered = [...numbers].sort((a, b) => a - b);
  let consecutivePairs = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index] - ordered[index - 1] === 1) consecutivePairs += 1;
  }

  return {
    consecutivePairs: round(1 - consecutivePairs / Math.max(1, numbers.length - 1), 3),
    endingDigitSpread: round(new Set(numbers.map((number) => number % 10)).size / Math.max(1, numbers.length), 3),
    gapVariance: round(range(ordered), 3),
    centerPull: round(1 - Math.abs(median(numbers) - average(numbers)) / Math.max(1, Math.max(...numbers)), 3),
  };
}

function pairScore(numbers: number[], history: DrawRecord[]): PatternBreakdown {
  const pairCounts = new Map<string, number>();
  for (const draw of history) {
    const ordered = [...draw.numbers].sort((a, b) => a - b);
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const key = `${ordered[i]}-${ordered[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const ordered = [...numbers].sort((a, b) => a - b);
  let score = 0;
  let total = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      total += 1;
      score += pairCounts.get(`${ordered[i]}-${ordered[j]}`) ? 1 : 0;
    }
  }

  return {
    coOccurrence: round(score / Math.max(1, total), 3),
    repeatPairs: round(score / Math.max(1, history.length), 3),
  };
}

function movingAverageScore(numbers: number[], history: DrawRecord[], maxNumber: number): PatternBreakdown {
  const recent = history.slice(-10);
  const recentAvg = average(recent.flatMap((draw) => draw.numbers));
  const candidateAvg = average(numbers);
  return {
    movingAverageFit: round(1 - Math.abs(candidateAvg - recentAvg) / Math.max(1, maxNumber), 3),
    drawCycleFit: round(recent.length ? 1 - Math.abs(recentAvg - candidateAvg) / Math.max(1, maxNumber) : 0.5, 3),
  };
}

function entropyScore(numbers: number[], maxNumber: number): PatternBreakdown {
  const unique = new Set(numbers).size;
  const spread = numbers.length / Math.max(1, maxNumber);
  return {
    entropyBalance: round(Math.min(1, unique / Math.max(1, numbers.length)) * (1 - Math.abs(spread - 0.12)), 3),
    randomnessBalance: round(1 - Math.abs(sum(numbers) / Math.max(1, numbers.length) - maxNumber / 2) / maxNumber, 3),
  };
}

function monteCarloScore(numbers: number[], maxNumber: number): PatternBreakdown {
  const sorted = [...numbers].sort((a, b) => a - b);
  const spacing = sorted.slice(1).map((value, index) => value - sorted[index]);
  const spreadScore = spacing.length ? average(spacing) / Math.max(1, maxNumber / numbers.length) : 0.5;
  return {
    monteCarloFit: round(Math.min(1, spreadScore), 3),
  };
}

export function evaluatePatterns(
  numbers: number[],
  history: DrawRecord[],
  maxNumber: number,
): PatternSignal[] {
  const breakdowns = [
    {
      name: "frequency",
      breakdown: frequencyScore(numbers, history, maxNumber),
      explanation: "Ưu tiên số xuất hiện nhiều hơn trong lịch sử gần đây.",
    },
    {
      name: "cold",
      breakdown: coldScore(numbers, history, maxNumber),
      explanation: "Khuyến khích số lâu chưa xuất hiện để cân bằng lựa chọn.",
    },
    {
      name: "recentTrend",
      breakdown: recentTrendScore(numbers, history),
      explanation: "Bắt các số đang có quán tính trong vài kỳ gần nhất.",
    },
    {
      name: "ratio",
      breakdown: ratioScore(numbers, maxNumber),
      explanation: "Giữ tỷ lệ chẵn/lẻ, thấp/cao và tổng số ở vùng cân bằng.",
    },
    {
      name: "structure",
      breakdown: structuralScore(numbers),
      explanation: "Theo dõi khoảng cách, số liên tiếp và độ trải của dãy.",
    },
    {
      name: "pair",
      breakdown: pairScore(numbers, history),
      explanation: "Tăng điểm nếu cặp số từng đi cùng nhau trong dữ liệu lịch sử.",
    },
    {
      name: "movingAverage",
      breakdown: movingAverageScore(numbers, history, maxNumber),
      explanation: "So khớp với trung bình di động của các kỳ gần nhất.",
    },
    {
      name: "entropy",
      breakdown: entropyScore(numbers, maxNumber),
      explanation: "Giữ cân bằng giữa độ đa dạng và tính ngẫu nhiên.",
    },
    {
      name: "monteCarlo",
      breakdown: monteCarloScore(numbers, maxNumber),
      explanation: "Đánh giá mức phân tán mô phỏng qua mẫu ngẫu nhiên nhẹ.",
    },
  ];

  return breakdowns.map(({ name, breakdown, explanation }) => {
    const values = Object.values(breakdown);
    const score = values.length ? average(values) : 0;
    return {
      name,
      score,
      weight: 50,
      enabled: true,
      explanation,
    };
  });
}

export function resolvePatternWeights(weights: PatternWeights): PatternWeights {
  return Object.fromEntries(
    Object.entries(weights).map(([name, value]) => [
      name,
      {
        enabled: value.enabled,
        weight: Math.min(100, Math.max(0, value.weight)),
      },
    ]),
  );
}
