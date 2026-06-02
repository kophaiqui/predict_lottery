import type { DashboardSnapshot } from "./types";

export function buildMongoSummary(snapshot: DashboardSnapshot): string {
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
