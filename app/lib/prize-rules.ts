import type { DrawRecord, LotteryType, PrizeEvaluation, PrizeRule } from "./types";

export const PRIZE_RULES: Record<LotteryType, PrizeRule[]> = {
  mega645: [
    { match: 6, bonusMatch: 0, tier: "Jackpot" },
    { match: 5, bonusMatch: 0, tier: "Giáº£i nháº¥t" },
    { match: 4, bonusMatch: 0, tier: "Giáº£i nhÃ¬" },
    { match: 3, bonusMatch: 0, tier: "Giáº£i ba" },
  ],
  power655: [
    { match: 6, bonusMatch: 1, tier: "Jackpot" },
    { match: 5, bonusMatch: 1, tier: "Giáº£i nháº¥t" },
    { match: 5, bonusMatch: 0, tier: "Giáº£i nhÃ¬" },
    { match: 4, bonusMatch: 1, tier: "Giáº£i ba" },
    { match: 4, bonusMatch: 0, tier: "Giáº£i tÆ°" },
    { match: 3, bonusMatch: 1, tier: "Giáº£i nÄƒm" },
  ],
  power535: [
    { match: 5, bonusMatch: 0, tier: "Jackpot" },
    { match: 4, bonusMatch: 0, tier: "Prize 1" },
    { match: 3, bonusMatch: 0, tier: "Prize 2" },
  ],
  max3d: [
    { match: 3, bonusMatch: 0, tier: "Jackpot" },
    { match: 2, bonusMatch: 0, tier: "Giáº£i nháº¥t" },
    { match: 1, bonusMatch: 0, tier: "Giáº£i nhÃ¬" },
  ],
};

export function evaluatePrizeTier(params: {
  lotteryType: LotteryType;
  predictedNumbers: number[];
  actualDraw: DrawRecord;
}): PrizeEvaluation {
  const { lotteryType, predictedNumbers, actualDraw } = params;
  const ruleSet = PRIZE_RULES[lotteryType];
  const numberMatches = predictedNumbers.filter((number) => actualDraw.numbers.includes(number)).length;
  const bonusMatches = actualDraw.bonusNumbers.length
    ? predictedNumbers.filter((number) => actualDraw.bonusNumbers.includes(number)).length
    : 0;

  const matchedRule = ruleSet.find(
    (rule) => numberMatches >= rule.match && bonusMatches >= rule.bonusMatch,
  );

  const isWinning = Boolean(matchedRule);
  return {
    tier: matchedRule?.tier ?? null,
    match: numberMatches,
    bonusMatch: bonusMatches,
    prizeAmount: matchedRule ? estimatePrizeAmount(lotteryType, matchedRule.tier) : 0,
    isWinning,
  };
}

function estimatePrizeAmount(lotteryType: LotteryType, tier: string): number {
  const table: Record<LotteryType, Record<string, number>> = {
    mega645: {
      Jackpot: 12000000000,
      "Giáº£i nháº¥t": 10000000,
      "Giáº£i nhÃ¬": 300000,
      "Giáº£i ba": 30000,
    },
    power655: {
      Jackpot: 18000000000,
      "Giáº£i nháº¥t": 15000000,
      "Giáº£i nhÃ¬": 500000,
      "Giáº£i ba": 50000,
      "Giáº£i tÆ°": 40000,
      "Giáº£i nÄƒm": 30000,
    },
    power535: {
      Jackpot: 10000000,
      "Prize 1": 1000000,
      "Prize 2": 100000,
    },
    max3d: {
      Jackpot: 10000000,
      "Giáº£i nháº¥t": 1000000,
      "Giáº£i nhÃ¬": 100000,
    },
  };

  return table[lotteryType][tier] ?? 0;
}


