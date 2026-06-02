export type LotteryType = "mega645" | "power655" | "power535" | "max3d" | "keno";

export type ConfidenceLabel = "Low" | "Medium" | "High";
export type PredictionStatus = "pending" | "checked";

export type CrawlStatus = "idle" | "running" | "success" | "error";

export interface ResultSelectorMap {
  date?: string;
  numbers?: string;
  specialNumber?: string;
  jackpot?: string;
  jackpot1?: string;
  jackpot2?: string;
  rows?: string;
  drawId?: string;
}

export interface LotteryConfig {
  type: LotteryType;
  name: string;
  sourceUrl: string;
  maxNumber: number;
  pickCount: number;
  drawCount?: number;
  hasBonus: boolean;
  bonusName?: string;
  drawDays: number[];
  sourceFormat: "html" | "json" | "api" | "manual";
  resultSelectorMap: ResultSelectorMap;
  notes: string;
}

export interface JackpotData {
  [key: string]: string | number | null | undefined;
}

export interface DrawRecord {
  lotteryType: LotteryType;
  drawDate: string;
  drawId: string;
  numbers: number[];
  bonusNumbers: number[];
  jackpotData: JackpotData;
  sourceUrl: string;
  source?: string;
  importedAt?: string;
  crawledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PatternBreakdown {
  [patternName: string]: number;
}

export interface PatternWeights {
  [patternName: string]: {
    enabled: boolean;
    weight: number;
  };
}

export interface PredictionSet {
  numbers: number[];
  score: number;
  coverageScore?: number;
  patternBreakdown: PatternBreakdown;
  modelWeights: Record<string, number>;
  reasons: string[];
}

export interface PredictionRecord {
  id: string;
  lotteryType: LotteryType;
  targetDrawDate: string;
  generatedAt: string;
  modelVersion?: string;
  algorithmVersion?: string;
  weightsSnapshot?: PatternWeights;
  configSnapshot?: LotteryConfig;
  predictedSets: PredictionSet[];
  status: PredictionStatus;
  actualResult: number[] | null;
  accuracy: number | null;
}

export interface PatternSignal {
  name: string;
  score: number;
  weight: number;
  enabled: boolean;
  explanation: string;
}

export interface ModelPerformance {
  weights: PatternWeights;
  patternStats: PatternPerformanceMap;
  learningRate: number;
  lastUpdated: string;
  version?: string;
}

export interface CrawlSummary {
  status: CrawlStatus;
  message: string;
  newRecords: number;
  updatedRecords: number;
}

export interface BacktestParams {
  lotteryType: LotteryType;
  trainWindow: number;
  testWindow: number;
  fromDate: string;
  toDate: string;
}

export interface BacktestRow {
  drawDate: string;
  predicted: string;
  actual: string;
  hits: number;
  score: number;
  confidence: ConfidenceLabel;
}

export interface BacktestResult {
  params: BacktestParams;
  rows: BacktestRow[];
  hitDistribution: Record<string, number>;
  averageHits: number;
  bestPatternNames: string[];
  summary: string;
}

export interface RollingBacktestResult extends BacktestResult {
  modelAverageMatch: number;
  randomAverageMatch: number;
  edge: number;
  warnings: string[];
}

export interface PrizeRule {
  match: number;
  bonusMatch: number;
  tier: string;
}

export interface PrizeEvaluation {
  tier: string | null;
  match: number;
  bonusMatch: number;
  prizeAmount: number;
  isWinning: boolean;
}

export interface CrawlQualityIssue {
  code:
    | "missing-draw"
    | "duplicate-draw"
    | "invalid-number-count"
    | "out-of-range"
    | "bad-date"
    | "missing-bonus"
    | "format-changed";
  severity: "info" | "warn" | "error";
  message: string;
}

export interface CrawlQualityReport {
  accepted: boolean;
  issues: CrawlQualityIssue[];
  acceptedCount: number;
  rejectedCount: number;
}

export interface PatternPerformanceStat {
  usedCount: number;
  avgMatch: number;
  randomBaseline: number;
  edge: number;
  lastUpdated: string;
}

export interface PatternPerformanceMap {
  [patternName: string]: PatternPerformanceStat;
}

export interface ModelVersionSnapshot {
  modelVersion: string;
  algorithmVersion: string;
  weightsSnapshot: PatternWeights;
  configSnapshot: LotteryConfig;
  generatedAt: string;
}

export interface BudgetState {
  budgetPerRound: number;
  ticketPrice: number;
  maxSetsPerRound: number;
  totalSpent: number;
  totalWon: number;
  profit: number;
  roi: number;
  warning: string | null;
}

export interface ManualFeedbackEntry {
  reason:
    | "score-high"
    | "coverage-good"
    | "manual"
    | "gut-feel"
    | "pattern-specific";
  note: string;
  createdAt: string;
}

export interface DashboardSnapshot {
  draws: DrawRecord[];
  predictions: PredictionRecord[];
  performance: ModelPerformance;
}

export type ActualDraw = DrawRecord;

export type GeneratedPrediction = PredictionRecord;

export interface PurchasedSet {
  id: string;
  lotteryType: LotteryType;
  targetDrawDate: string;
  predictionId?: string;
  selectedNumbers: number[];
  reason?: string;
  ticketPrice: number;
  totalCost: number;
  createdAt: string;
}

export interface Evaluation {
  id: string;
  lotteryType: LotteryType;
  drawId: string;
  predictionId?: string;
  purchasedSetId?: string;
  actualNumbers: number[];
  predictedNumbers: number[];
  matchCount: number;
  prizeAmount: number;
  createdAt: string;
}

export interface CrawlLog {
  lotteryType: LotteryType;
  accepted: boolean;
  issues: CrawlQualityIssue[];
  acceptedCount: number;
  rejectedCount: number;
  checkedAt: string;
  sourceUrl?: string;
}

export interface BacktestResultDocument extends RollingBacktestResult {
  lotteryType: LotteryType;
  createdAt: string;
}
