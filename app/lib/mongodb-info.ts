import type { DashboardSnapshot } from "./types";

export function buildMongoSummary(snapshot: DashboardSnapshot): string {
  return `MongoDB Atlas sẵn sàng đồng bộ ${snapshot.draws.length} kỳ quay và ${snapshot.predictions.length} dự đoán.`;
}

export function getMongoSchema(): string {
  return `actualDraws
{
  lotteryType,
  drawId,
  drawDate,
  numbers,
  bonusNumbers,
  jackpotData,
  sourceUrl,
  source,
  importedAt,
  crawledAt,
  createdAt,
  updatedAt
}

generatedPredictions
{
  lotteryType,
  targetDrawDate,
  generatedAt,
  modelVersion,
  algorithmVersion,
  weightsSnapshot,
  configSnapshot,
  predictedSets,
  status,
  actualResult,
  accuracy
}

purchasedNumbers
{
  lotteryType,
  targetDrawDate,
  predictionId,
  selectedNumbers,
  ticketPrice,
  totalCost,
  reason,
  createdAt
}

evaluationResults
{
  id,
  lotteryType,
  drawId,
  predictionId,
  purchasedSetId,
  matchCount,
  prizeAmount,
  actualNumbers,
  predictedNumbers,
  createdAt
}

modelPerformance
{
  _id,
  weights,
  patternStats,
  learningRate,
  lastUpdated,
  updatedAt
}

systemLogs
{
  lotteryType,
  accepted,
  issues,
  acceptedCount,
  rejectedCount,
  checkedAt,
  sourceUrl
}

modelVersions
{
  modelVersion,
  algorithmVersion,
  weightsSnapshot,
  configSnapshot,
  generatedAt,
  updatedAt
}

backtestResults
{
  lotteryType,
  params,
  rows,
  averageHits,
  modelAverageMatch,
  randomAverageMatch,
  edge,
  warnings,
  createdAt
}`;
}
