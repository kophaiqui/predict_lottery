import "server-only";

import { Pool } from "pg";
import type {
  BacktestResult,
  CrawlQualityReport,
  DashboardSnapshot,
  DrawRecord,
  Evaluation,
  LotteryType,
  ModelPerformance,
  ModelVersionSnapshot,
  PredictionRecord,
  PurchasedSet,
} from "./types";

type LooseModelVersionSnapshot = Partial<ModelVersionSnapshot> & { modelVersion: string };

const DATABASE_URL = process.env.DATABASE_URL;

type GlobalPg = typeof globalThis & {
  pgPool?: Pool | null;
  pgTablesReady?: Promise<void> | null;
};

const globalForPg = globalThis as GlobalPg;

function requireDatabaseUrl() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL chưa được cấu hình.");
  }
  return DATABASE_URL;
}

export function isMongoConfigured(): boolean {
  return Boolean(DATABASE_URL);
}

export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new Pool({ connectionString: requireDatabaseUrl() });
  }
  return globalForPg.pgPool;
}

async function createTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS actual_draws (
      lottery_type TEXT NOT NULL,
      draw_id TEXT NOT NULL,
      draw_date TEXT NOT NULL,
      numbers JSONB NOT NULL DEFAULT '[]',
      bonus_numbers JSONB NOT NULL DEFAULT '[]',
      jackpot_data JSONB NOT NULL DEFAULT '{}',
      source_url TEXT NOT NULL DEFAULT '',
      source TEXT,
      imported_at TEXT,
      crawled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(lottery_type, draw_id)
    );

    CREATE TABLE IF NOT EXISTS generated_predictions (
      id TEXT NOT NULL,
      lottery_type TEXT NOT NULL,
      target_draw_date TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      model_version TEXT,
      algorithm_version TEXT,
      weights_snapshot JSONB,
      config_snapshot JSONB,
      predicted_sets JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      actual_result JSONB,
      accuracy DOUBLE PRECISION,
      UNIQUE(lottery_type, target_draw_date)
    );

    CREATE TABLE IF NOT EXISTS purchased_numbers (
      id TEXT,
      lottery_type TEXT NOT NULL,
      target_draw_date TEXT NOT NULL,
      prediction_id TEXT,
      selected_numbers JSONB NOT NULL DEFAULT '[]',
      ticket_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(lottery_type, target_draw_date)
    );

    CREATE TABLE IF NOT EXISTS evaluation_results (
      id TEXT PRIMARY KEY,
      lottery_type TEXT NOT NULL,
      draw_id TEXT NOT NULL,
      prediction_id TEXT,
      purchased_set_id TEXT,
      match_count INTEGER NOT NULL DEFAULT 0,
      prize_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      actual_numbers JSONB NOT NULL DEFAULT '[]',
      predicted_numbers JSONB NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_performance (
      id TEXT PRIMARY KEY,
      weights JSONB NOT NULL DEFAULT '{}',
      pattern_stats JSONB NOT NULL DEFAULT '{}',
      learning_rate DOUBLE PRECISION NOT NULL DEFAULT 0.04,
      last_updated TEXT NOT NULL,
      version TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_logs (
      id SERIAL PRIMARY KEY,
      lottery_type TEXT NOT NULL,
      accepted BOOLEAN NOT NULL DEFAULT false,
      issues JSONB NOT NULL DEFAULT '[]',
      accepted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT,
      source_url TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_versions (
      model_version TEXT PRIMARY KEY,
      algorithm_version TEXT,
      weights_snapshot JSONB,
      config_snapshot JSONB,
      generated_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backtest_results (
      id SERIAL PRIMARY KEY,
      lottery_type TEXT NOT NULL,
      params JSONB NOT NULL DEFAULT '{}',
      rows JSONB NOT NULL DEFAULT '[]',
      hit_distribution JSONB NOT NULL DEFAULT '{}',
      average_hits DOUBLE PRECISION NOT NULL DEFAULT 0,
      best_pattern_names JSONB NOT NULL DEFAULT '[]',
      summary TEXT,
      model_average_match DOUBLE PRECISION NOT NULL DEFAULT 0,
      random_average_match DOUBLE PRECISION NOT NULL DEFAULT 0,
      edge DOUBLE PRECISION NOT NULL DEFAULT 0,
      warnings JSONB NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
}

export async function ensureDbReady(): Promise<Pool> {
  const pool = getPool();
  if (!globalForPg.pgTablesReady) {
    globalForPg.pgTablesReady = createTables(pool).catch((error) => {
      globalForPg.pgTablesReady = null;
      throw error;
    });
  }
  await globalForPg.pgTablesReady;
  return pool;
}

function rowToDrawRecord(row: Record<string, unknown>): DrawRecord {
  return {
    lotteryType: row.lottery_type as LotteryType,
    drawId: row.draw_id as string,
    drawDate: row.draw_date as string,
    numbers: row.numbers as number[],
    bonusNumbers: row.bonus_numbers as number[],
    jackpotData: row.jackpot_data as DrawRecord["jackpotData"],
    sourceUrl: row.source_url as string,
    source: row.source as string | undefined,
    importedAt: row.imported_at as string | undefined,
    crawledAt: row.crawled_at as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToPredictionRecord(row: Record<string, unknown>): PredictionRecord {
  return {
    id: row.id as string,
    lotteryType: row.lottery_type as LotteryType,
    targetDrawDate: row.target_draw_date as string,
    generatedAt: row.generated_at as string,
    modelVersion: row.model_version as string | undefined,
    algorithmVersion: row.algorithm_version as string | undefined,
    weightsSnapshot: row.weights_snapshot as PredictionRecord["weightsSnapshot"],
    configSnapshot: row.config_snapshot as PredictionRecord["configSnapshot"],
    predictedSets: row.predicted_sets as PredictionRecord["predictedSets"],
    status: row.status as PredictionRecord["status"],
    actualResult: row.actual_result as number[] | null,
    accuracy: row.accuracy as number | null,
  };
}

export async function upsertActualDraws(draws: DrawRecord[]) {
  const pool = await ensureDbReady();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const draw of draws) {
    const existing = await pool.query<Record<string, unknown>>(
      `SELECT * FROM actual_draws WHERE lottery_type = $1 AND (draw_id = $2 OR draw_date = $3) LIMIT 1`,
      [draw.lotteryType, draw.drawId, draw.drawDate],
    );
    const existingRow = existing.rows[0];
    const now = new Date().toISOString();

    const isSame =
      Boolean(existingRow) &&
      existingRow.draw_id === draw.drawId &&
      existingRow.draw_date === draw.drawDate &&
      JSON.stringify(existingRow.numbers ?? []) === JSON.stringify(draw.numbers) &&
      JSON.stringify(existingRow.bonus_numbers ?? []) === JSON.stringify(draw.bonusNumbers) &&
      JSON.stringify(existingRow.jackpot_data ?? {}) === JSON.stringify(draw.jackpotData ?? {}) &&
      existingRow.source_url === draw.sourceUrl &&
      (existingRow.source ?? undefined) === (draw.source ?? undefined) &&
      (existingRow.crawled_at ?? undefined) === (draw.crawledAt ?? undefined);

    if (isSame) {
      skipped += 1;
      continue;
    }

    await pool.query(
      `DELETE FROM actual_draws WHERE lottery_type = $1 AND draw_date = $2 AND draw_id != $3`,
      [draw.lotteryType, draw.drawDate, draw.drawId],
    );

    if (existingRow) {
      await pool.query(
        `UPDATE actual_draws SET
          draw_id = $1, draw_date = $2, numbers = $3::jsonb, bonus_numbers = $4::jsonb,
          jackpot_data = $5::jsonb, source_url = $6, source = $7, imported_at = $8,
          crawled_at = $9, updated_at = $10
        WHERE lottery_type = $11 AND draw_id = $12`,
        [
          draw.drawId, draw.drawDate,
          JSON.stringify(draw.numbers), JSON.stringify(draw.bonusNumbers),
          JSON.stringify(draw.jackpotData), draw.sourceUrl,
          draw.source ?? null, draw.importedAt ?? null,
          draw.crawledAt ?? null, now,
          draw.lotteryType, existingRow.draw_id,
        ],
      );
      updated += 1;
    } else {
      await pool.query(
        `INSERT INTO actual_draws
          (lottery_type, draw_id, draw_date, numbers, bonus_numbers, jackpot_data,
           source_url, source, imported_at, crawled_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (lottery_type, draw_id) DO UPDATE SET
          draw_date = EXCLUDED.draw_date,
          numbers = EXCLUDED.numbers,
          bonus_numbers = EXCLUDED.bonus_numbers,
          jackpot_data = EXCLUDED.jackpot_data,
          source_url = EXCLUDED.source_url,
          source = EXCLUDED.source,
          imported_at = EXCLUDED.imported_at,
          crawled_at = EXCLUDED.crawled_at,
          updated_at = EXCLUDED.updated_at`,
        [
          draw.lotteryType, draw.drawId, draw.drawDate,
          JSON.stringify(draw.numbers), JSON.stringify(draw.bonusNumbers),
          JSON.stringify(draw.jackpotData), draw.sourceUrl,
          draw.source ?? null, draw.importedAt ?? null,
          draw.crawledAt ?? null, draw.createdAt ?? now, now,
        ],
      );
      inserted += 1;
    }
  }

  return { inserted, updated, skipped };
}

export async function readActualDraws(lotteryType?: DrawRecord["lotteryType"]) {
  const pool = await ensureDbReady();
  const result = lotteryType
    ? await pool.query(`SELECT * FROM actual_draws WHERE lottery_type = $1 ORDER BY draw_date DESC`, [lotteryType])
    : await pool.query(`SELECT * FROM actual_draws ORDER BY draw_date DESC`);
  return result.rows.map(rowToDrawRecord);
}

export async function deleteActualDraws(lotteryType: DrawRecord["lotteryType"]) {
  const pool = await ensureDbReady();
  const result = await pool.query(`DELETE FROM actual_draws WHERE lottery_type = $1`, [lotteryType]);
  return result.rowCount ?? 0;
}

export async function replaceActualDraws(lotteryType: DrawRecord["lotteryType"], draws: DrawRecord[]) {
  const pool = await ensureDbReady();
  const deleteResult = await pool.query(`DELETE FROM actual_draws WHERE lottery_type = $1`, [lotteryType]);
  const deleted = deleteResult.rowCount ?? 0;

  if (!draws.length) {
    return { deleted, inserted: 0, updated: 0, skipped: 0 };
  }

  const now = new Date().toISOString();
  for (const draw of draws) {
    await pool.query(
      `INSERT INTO actual_draws
        (lottery_type, draw_id, draw_date, numbers, bonus_numbers, jackpot_data,
         source_url, source, imported_at, crawled_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (lottery_type, draw_id) DO NOTHING`,
      [
        draw.lotteryType, draw.drawId, draw.drawDate,
        JSON.stringify(draw.numbers), JSON.stringify(draw.bonusNumbers),
        JSON.stringify(draw.jackpotData), draw.sourceUrl,
        draw.source ?? null, draw.importedAt ?? null,
        draw.crawledAt ?? null, draw.createdAt ?? now, now,
      ],
    );
  }

  return { deleted, inserted: draws.length, updated: 0, skipped: 0 };
}

export async function upsertGeneratedPrediction(prediction: PredictionRecord) {
  const pool = await ensureDbReady();
  await pool.query(
    `INSERT INTO generated_predictions
      (id, lottery_type, target_draw_date, generated_at, model_version, algorithm_version,
       weights_snapshot, config_snapshot, predicted_sets, status, actual_result, accuracy)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12)
    ON CONFLICT (lottery_type, target_draw_date) DO UPDATE SET
      id = EXCLUDED.id,
      generated_at = EXCLUDED.generated_at,
      model_version = EXCLUDED.model_version,
      algorithm_version = EXCLUDED.algorithm_version,
      weights_snapshot = EXCLUDED.weights_snapshot,
      config_snapshot = EXCLUDED.config_snapshot,
      predicted_sets = EXCLUDED.predicted_sets,
      status = EXCLUDED.status,
      actual_result = EXCLUDED.actual_result,
      accuracy = EXCLUDED.accuracy`,
    [
      prediction.id, prediction.lotteryType, prediction.targetDrawDate, prediction.generatedAt,
      prediction.modelVersion ?? null, prediction.algorithmVersion ?? null,
      prediction.weightsSnapshot ? JSON.stringify(prediction.weightsSnapshot) : null,
      prediction.configSnapshot ? JSON.stringify(prediction.configSnapshot) : null,
      JSON.stringify(prediction.predictedSets), prediction.status,
      prediction.actualResult ? JSON.stringify(prediction.actualResult) : null,
      prediction.accuracy ?? null,
    ],
  );
}

export async function upsertPurchasedSet(purchasedSet: PurchasedSet) {
  const pool = await ensureDbReady();
  await pool.query(
    `INSERT INTO purchased_numbers
      (id, lottery_type, target_draw_date, prediction_id, selected_numbers,
       ticket_price, total_cost, reason, created_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
    ON CONFLICT (lottery_type, target_draw_date) DO UPDATE SET
      id = EXCLUDED.id,
      prediction_id = EXCLUDED.prediction_id,
      selected_numbers = EXCLUDED.selected_numbers,
      ticket_price = EXCLUDED.ticket_price,
      total_cost = EXCLUDED.total_cost,
      reason = EXCLUDED.reason`,
    [
      purchasedSet.id ?? null, purchasedSet.lotteryType, purchasedSet.targetDrawDate,
      purchasedSet.predictionId ?? null,
      JSON.stringify(purchasedSet.selectedNumbers),
      purchasedSet.ticketPrice, purchasedSet.totalCost,
      purchasedSet.reason ?? null, purchasedSet.createdAt,
    ],
  );
}

export async function readPurchasedSets() {
  const pool = await ensureDbReady();
  const result = await pool.query(`SELECT * FROM purchased_numbers ORDER BY created_at DESC`);
  return result.rows.map((row) => ({
    id: row.id as string,
    lotteryType: row.lottery_type as LotteryType,
    targetDrawDate: row.target_draw_date as string,
    predictionId: row.prediction_id as string | undefined,
    selectedNumbers: row.selected_numbers as number[],
    ticketPrice: Number(row.ticket_price),
    totalCost: Number(row.total_cost),
    reason: row.reason as string | undefined,
    createdAt: row.created_at as string,
  }));
}

export async function upsertEvaluation(evaluation: Evaluation) {
  const pool = await ensureDbReady();
  await pool.query(
    `INSERT INTO evaluation_results
      (id, lottery_type, draw_id, prediction_id, purchased_set_id,
       match_count, prize_amount, actual_numbers, predicted_numbers, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
    ON CONFLICT (id) DO UPDATE SET
      lottery_type = EXCLUDED.lottery_type,
      draw_id = EXCLUDED.draw_id,
      prediction_id = EXCLUDED.prediction_id,
      purchased_set_id = EXCLUDED.purchased_set_id,
      match_count = EXCLUDED.match_count,
      prize_amount = EXCLUDED.prize_amount,
      actual_numbers = EXCLUDED.actual_numbers,
      predicted_numbers = EXCLUDED.predicted_numbers`,
    [
      evaluation.id, evaluation.lotteryType, evaluation.drawId,
      evaluation.predictionId ?? null, evaluation.purchasedSetId ?? null,
      evaluation.matchCount, evaluation.prizeAmount,
      JSON.stringify(evaluation.actualNumbers),
      JSON.stringify(evaluation.predictedNumbers),
      evaluation.createdAt,
    ],
  );
}

export async function upsertModelPerformance(performance: ModelPerformance, lotteryType: LotteryType | "global" = "global") {
  const pool = await ensureDbReady();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO model_performance (id, weights, pattern_stats, learning_rate, last_updated, version, updated_at)
    VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      weights = EXCLUDED.weights,
      pattern_stats = EXCLUDED.pattern_stats,
      learning_rate = EXCLUDED.learning_rate,
      last_updated = EXCLUDED.last_updated,
      version = EXCLUDED.version,
      updated_at = EXCLUDED.updated_at`,
    [
      lotteryType,
      JSON.stringify(performance.weights),
      JSON.stringify(performance.patternStats),
      performance.learningRate,
      performance.lastUpdated,
      performance.version ?? null,
      now,
    ],
  );
}

export async function insertCrawlLog(report: CrawlQualityReport & { lotteryType: LotteryType; sourceUrl?: string }) {
  const pool = await ensureDbReady();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO system_logs
      (lottery_type, accepted, issues, accepted_count, rejected_count, checked_at, source_url, created_at)
    VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
    [
      report.lotteryType, report.accepted,
      JSON.stringify(report.issues),
      report.acceptedCount, report.rejectedCount,
      now, report.sourceUrl ?? null, now,
    ],
  );
}

export async function insertBacktestResult(result: BacktestResult & { lotteryType: LotteryType; createdAt?: string }) {
  const pool = await ensureDbReady();
  const now = new Date().toISOString();
  const r = result as BacktestResult & {
    lotteryType: LotteryType;
    createdAt?: string;
    modelAverageMatch?: number;
    randomAverageMatch?: number;
    edge?: number;
    warnings?: string[];
  };
  await pool.query(
    `INSERT INTO backtest_results
      (lottery_type, params, rows, hit_distribution, average_hits, best_pattern_names,
       summary, model_average_match, random_average_match, edge, warnings, created_at)
    VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb, $12)`,
    [
      r.lotteryType,
      JSON.stringify(r.params),
      JSON.stringify(r.rows),
      JSON.stringify(r.hitDistribution ?? {}),
      r.averageHits ?? 0,
      JSON.stringify(r.bestPatternNames ?? []),
      r.summary ?? null,
      r.modelAverageMatch ?? 0,
      r.randomAverageMatch ?? 0,
      r.edge ?? 0,
      JSON.stringify(r.warnings ?? []),
      r.createdAt ?? now,
    ],
  );
}

export async function insertModelVersion(snapshot: LooseModelVersionSnapshot) {
  const pool = await ensureDbReady();
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO model_versions
      (model_version, algorithm_version, weights_snapshot, config_snapshot, generated_at, updated_at)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
    ON CONFLICT (model_version) DO UPDATE SET
      algorithm_version = EXCLUDED.algorithm_version,
      weights_snapshot = EXCLUDED.weights_snapshot,
      config_snapshot = EXCLUDED.config_snapshot,
      generated_at = EXCLUDED.generated_at,
      updated_at = EXCLUDED.updated_at`,
    [
      snapshot.modelVersion,
      snapshot.algorithmVersion ?? null,
      snapshot.weightsSnapshot ? JSON.stringify(snapshot.weightsSnapshot) : null,
      snapshot.configSnapshot ? JSON.stringify(snapshot.configSnapshot) : null,
      snapshot.generatedAt ?? null,
      now,
    ],
  );
}

export async function readMongoSnapshot(): Promise<DashboardSnapshot> {
  const pool = await ensureDbReady();
  const [drawsResult, predictionsResult, perfResult] = await Promise.all([
    pool.query(`SELECT * FROM actual_draws ORDER BY draw_date ASC`),
    pool.query(`SELECT * FROM generated_predictions ORDER BY generated_at DESC`),
    pool.query(`SELECT * FROM model_performance WHERE id = 'global' LIMIT 1`),
  ]);

  const draws = drawsResult.rows.map(rowToDrawRecord);
  const predictions = predictionsResult.rows.map(rowToPredictionRecord);
  const perfRow = perfResult.rows[0];
  const performance: ModelPerformance = perfRow
    ? {
        weights: perfRow.weights as ModelPerformance["weights"],
        patternStats: perfRow.pattern_stats as ModelPerformance["patternStats"],
        learningRate: Number(perfRow.learning_rate),
        lastUpdated: perfRow.last_updated as string,
        version: perfRow.version as string | undefined,
      }
    : {
        weights: {},
        patternStats: {},
        learningRate: 0.04,
        lastUpdated: new Date().toISOString(),
      };

  return { draws, predictions, performance };
}

export async function writeMongoSnapshot(snapshot: DashboardSnapshot) {
  const [drawResult, predictionResult] = await Promise.all([
    upsertActualDraws(snapshot.draws),
    Promise.all(snapshot.predictions.map((p) => upsertGeneratedPrediction(p))),
  ]);
  await upsertModelPerformance(snapshot.performance);
  return { draws: drawResult, predictions: predictionResult.length };
}

export async function testMongoConnection() {
  const pool = await ensureDbReady();
  const startedAt = Date.now();
  const result = await pool.query(`SELECT NOW() AS now`);
  return {
    ok: Boolean(result.rows[0]),
    message: result.rows[0] ? "PostgreSQL hoạt động bình thường." : "Không thể query PostgreSQL.",
    latencyMs: Date.now() - startedAt,
  };
}

export function buildMongoSummary(snapshot: DashboardSnapshot): string {
  if (!isMongoConfigured()) {
    return "DATABASE_URL chưa được cấu hình, app đang chạy với local persistence.";
  }
  return `PostgreSQL sẵn sàng đồng bộ ${snapshot.draws.length} kỳ quay và ${snapshot.predictions.length} dự đoán.`;
}

export function getMongoSchema(): string {
  return `actual_draws
{
  lottery_type,
  draw_id,
  draw_date,
  numbers,
  bonus_numbers,
  jackpot_data,
  source_url,
  source,
  imported_at,
  crawled_at,
  created_at,
  updated_at
}

generated_predictions
{
  id,
  lottery_type,
  target_draw_date,
  generated_at,
  model_version,
  algorithm_version,
  weights_snapshot,
  config_snapshot,
  predicted_sets,
  status,
  actual_result,
  accuracy
}

purchased_numbers
{
  id,
  lottery_type,
  target_draw_date,
  prediction_id,
  selected_numbers,
  ticket_price,
  total_cost,
  reason,
  created_at
}

evaluation_results
{
  id,
  lottery_type,
  draw_id,
  prediction_id,
  purchased_set_id,
  match_count,
  prize_amount,
  actual_numbers,
  predicted_numbers,
  created_at
}

model_performance
{
  id,
  weights,
  pattern_stats,
  learning_rate,
  last_updated,
  version,
  updated_at
}

system_logs
{
  id,
  lottery_type,
  accepted,
  issues,
  accepted_count,
  rejected_count,
  checked_at,
  source_url,
  created_at
}

model_versions
{
  model_version,
  algorithm_version,
  weights_snapshot,
  config_snapshot,
  generated_at,
  updated_at
}

backtest_results
{
  id,
  lottery_type,
  params,
  rows,
  hit_distribution,
  average_hits,
  best_pattern_names,
  summary,
  model_average_match,
  random_average_match,
  edge,
  warnings,
  created_at
}`;
}
