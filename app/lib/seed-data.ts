import { LOTTERY_CONFIG } from "./lottery-config";
import type { DrawRecord, LotteryType } from "./types";
import { createId, formatDate, seededRandom, uniqueSorted } from "./number-utils";

function buildDraws(lotteryType: LotteryType, seed: number, count: number): DrawRecord[] {
  const config = LOTTERY_CONFIG[lotteryType];
  const random = seededRandom(seed);
  const draws: DrawRecord[] = [];
  const baseDate = new Date("2025-01-01T00:00:00.000Z");

  for (let index = 0; index < count; index += 1) {
    const drawDate = new Date(baseDate);
    drawDate.setDate(baseDate.getDate() + index * 7);

    const numbers = uniqueSorted(
      Array.from({ length: config.pickCount }, () =>
        Math.floor(random() * config.maxNumber) + 1,
      ),
    ).slice(0, config.pickCount);

    while (numbers.length < config.pickCount) {
      const candidate = Math.floor(random() * config.maxNumber) + 1;
      if (!numbers.includes(candidate)) {
        numbers.push(candidate);
        numbers.sort((a, b) => a - b);
      }
    }

    const bonusNumbers = config.hasBonus
      ? [Math.floor(random() * config.maxNumber) + 1]
      : [];

    draws.push({
      lotteryType,
      drawDate: formatDate(drawDate),
      drawId: createId(lotteryType, formatDate(drawDate), String(index + 1)),
      numbers,
      bonusNumbers,
      jackpotData: {
        jackpot1: Math.floor(random() * 25000000000) + 5000000000,
        jackpot2: config.hasBonus ? Math.floor(random() * 8000000000) + 1200000000 : null,
      },
      sourceUrl: config.sourceUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return draws;
}

export function buildSeedSnapshot() {
  return {
    draws: [
      ...buildDraws("mega645", 64501, 18),
      ...buildDraws("power655", 65501, 18),
      ...buildDraws("power535", 53501, 18),
      ...buildDraws("max3d", 33001, 18),
    ],
  };
}


