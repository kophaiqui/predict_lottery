import "server-only";

import { MongoClient, type Db, type Document } from "mongodb";
import type {
  BacktestResult,
  CrawlQualityReport,
  DashboardSnapshot,
  DrawRecord,
  LotteryType,
  ModelPerformance,
  PredictionRecord,
} from "./types";

const MONGODB_URI = process.env.MONGODB_URI;

type GlobalMongo = typeof globalThis & {
  mongoClientPromise?: Promise<MongoClient> | null;
  mongoIndexesPromise?: Promise<void> | null;
};

const globalForMongo = globalThis as GlobalMongo;

const COLLECTIONS = {
  actualDraws: "actualDraws",
  generatedPredictions: "generatedPredictions",
  purchasedNumbers: "purchasedNumbers",
  evaluationResults: "evaluationResults",
  modelPerformance: "modelPerformance",
  systemLogs: "systemLogs",
  modelVersions: "modelVersions",
  backtestResults: "backtestResults",
} as const;

function requireMongoUri() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI chưa được cấu hình.");
  }
  return MONGODB_URI;
}

export function isMongoConfigured(): boolean {
  return Boolean(MONGODB_URI);
}

export async function getMongoClient(): Promise<MongoClient> {
  if (!globalForMongo.mongoClientPromise) {
    const client = new MongoClient(requireMongoUri());
    globalForMongo.mongoClientPromise = client.connect();
  }

  return globalForMongo.mongoClientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db();
}

async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection(COLLECTIONS.actualDraws).createIndex({ lotteryType: 1, drawId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.generatedPredictions).createIndex(
      { lotteryType: 1, targetDrawDate: 1 },
      { unique: true },
    ),
    db.collection(COLLECTIONS.purchasedNumbers).createIndex({ lotteryType: 1, targetDrawDate: 1 }, { unique: true }),
    db.collection(COLLECTIONS.evaluationResults).createIndex({ id: 1 }, { unique: true }),
    db.collection(COLLECTIONS.modelVersions).createIndex({ modelVersion: 1 }, { unique: true }),
    db.collection(COLLECTIONS.backtestResults).createIndex({ createdAt: -1 }),
    db.collection(COLLECTIONS.systemLogs).createIndex({ checkedAt: -1 }),
  ]);
}

export async function ensureMongoReady(): Promise<Db> {
  const db = await getMongoDb();
  if (!globalForMongo.mongoIndexesPromise) {
    globalForMongo.mongoIndexesPromise = ensureIndexes(db).catch((error) => {
      globalForMongo.mongoIndexesPromise = null;
      throw error;
    });
  }

  await globalForMongo.mongoIndexesPromise;
  return db;
}

export async function upsertActualDraws(draws: DrawRecord[]) {
  const db = await ensureMongoReady();
  const collection = db.collection<DrawRecord>(COLLECTIONS.actualDraws);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const draw of draws) {
    const existing = await collection.findOne({ lotteryType: draw.lotteryType, drawId: draw.drawId });
    const now = new Date().toISOString();
    const isSame =
      Boolean(existing) &&
      existing?.drawDate === draw.drawDate &&
      JSON.stringify(existing?.numbers ?? []) === JSON.stringify(draw.numbers) &&
      JSON.stringify(existing?.bonusNumbers ?? []) === JSON.stringify(draw.bonusNumbers) &&
      JSON.stringify(existing?.jackpotData ?? {}) === JSON.stringify(draw.jackpotData ?? {}) &&
      existing?.sourceUrl === draw.sourceUrl &&
      (existing?.source ?? undefined) === (draw.source ?? undefined) &&
      (existing?.crawledAt ?? undefined) === (draw.crawledAt ?? undefined);

    if (isSame) {
      skipped += 1;
      continue;
    }

    await collection.updateOne(
      { lotteryType: draw.lotteryType, drawId: draw.drawId },
      {
        $set: {
          ...draw,
          createdAt: existing?.createdAt ?? draw.createdAt ?? now,
          importedAt: existing?.importedAt ?? draw.importedAt,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    if (existing) updated += 1;
    else inserted += 1;
  }

  return { inserted, updated, skipped };
}

export async function readActualDraws(lotteryType?: DrawRecord["lotteryType"]) {
  const db = await ensureMongoReady();
  const query = lotteryType ? { lotteryType } : {};
  return db.collection<DrawRecord>(COLLECTIONS.actualDraws).find(query).sort({ drawDate: -1 }).toArray();
}

export async function upsertGeneratedPrediction(prediction: PredictionRecord) {
  const db = await ensureMongoReady();
  await db.collection<PredictionRecord>(COLLECTIONS.generatedPredictions).updateOne(
    { lotteryType: prediction.lotteryType, targetDrawDate: prediction.targetDrawDate },
    { $set: prediction },
    { upsert: true },
  );
}

export async function upsertPurchasedSet(purchasedSet: Document & { lotteryType: LotteryType; targetDrawDate: string }) {
  const db = await ensureMongoReady();
  await db.collection(COLLECTIONS.purchasedNumbers).updateOne(
    { lotteryType: purchasedSet.lotteryType, targetDrawDate: purchasedSet.targetDrawDate },
    { $set: purchasedSet },
    { upsert: true },
  );
}

export async function readPurchasedSets() {
  const db = await ensureMongoReady();
  return db.collection(COLLECTIONS.purchasedNumbers).find({}).sort({ createdAt: -1 }).toArray();
}

export async function upsertEvaluation(evaluation: Document & { id: string; lotteryType: LotteryType; drawId: string }) {
  const db = await ensureMongoReady();
  await db.collection(COLLECTIONS.evaluationResults).updateOne(
    { id: evaluation.id },
    { $set: evaluation },
    { upsert: true },
  );
}

export async function upsertModelPerformance(performance: ModelPerformance, lotteryType: LotteryType | "global" = "global") {
  const db = await ensureMongoReady();
  await db.collection<{ _id: string; performance?: ModelPerformance }>(COLLECTIONS.modelPerformance).updateOne(
    { _id: lotteryType },
    {
      $set: {
        _id: lotteryType,
        ...performance,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

export async function insertCrawlLog(report: CrawlQualityReport & { lotteryType: LotteryType; sourceUrl?: string }) {
  const db = await ensureMongoReady();
  await db.collection(COLLECTIONS.systemLogs).insertOne({
    ...report,
    createdAt: new Date().toISOString(),
  });
}

export async function insertBacktestResult(result: BacktestResult & { lotteryType: LotteryType; createdAt?: string }) {
  const db = await ensureMongoReady();
  await db.collection(COLLECTIONS.backtestResults).insertOne({
    ...result,
    createdAt: result.createdAt ?? new Date().toISOString(),
  });
}

export async function insertModelVersion(snapshot: Document & { modelVersion: string }) {
  const db = await ensureMongoReady();
  await db.collection(COLLECTIONS.modelVersions).updateOne(
    { modelVersion: snapshot.modelVersion },
    { $set: { ...snapshot, updatedAt: new Date().toISOString() } },
    { upsert: true },
  );
}

export async function readMongoSnapshot(): Promise<DashboardSnapshot> {
  const db = await ensureMongoReady();
  const [draws, predictions, performance] = await Promise.all([
    db.collection<DrawRecord>(COLLECTIONS.actualDraws).find({}).sort({ drawDate: 1 }).toArray(),
    db.collection<PredictionRecord>(COLLECTIONS.generatedPredictions).find({}).sort({ generatedAt: -1 }).toArray(),
    db.collection<{ _id: string } & ModelPerformance>(COLLECTIONS.modelPerformance).findOne({ _id: "global" }),
  ]);

  const nextPerformance: ModelPerformance = performance
    ? {
        weights: performance.weights,
        patternStats: performance.patternStats,
        learningRate: performance.learningRate,
        lastUpdated: performance.lastUpdated,
        version: performance.version,
      }
    : {
        weights: {},
        patternStats: {},
        learningRate: 0.04,
        lastUpdated: new Date().toISOString(),
      };

  return { draws, predictions, performance: nextPerformance };
}

export async function writeMongoSnapshot(snapshot: DashboardSnapshot) {
  const [drawResult, predictionResult] = await Promise.all([
    upsertActualDraws(snapshot.draws),
    Promise.all(snapshot.predictions.map((prediction) => upsertGeneratedPrediction(prediction))),
  ]);

  await upsertModelPerformance(snapshot.performance);

  return {
    draws: drawResult,
    predictions: predictionResult.length,
  };
}

export async function testMongoConnection() {
  const db = await ensureMongoReady();
  const collection = db.collection("connectionTests");
  const startedAt = Date.now();
  const doc = {
    status: "ok",
    checkedAt: new Date().toISOString(),
  };

  const insertResult = await collection.insertOne(doc);
  const readBack = await collection.findOne({ _id: insertResult.insertedId });
  await collection.deleteOne({ _id: insertResult.insertedId });

  return {
    ok: Boolean(readBack),
    message: readBack ? "MongoDB Atlas hoạt động bình thường." : "Không đọc lại được document test.",
    latencyMs: Date.now() - startedAt,
  };
}

export function buildMongoSummary(snapshot: DashboardSnapshot): string {
  if (!isMongoConfigured()) {
    return "MongoDB URI chưa được cấu hình, app đang chạy với local persistence.";
  }

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
