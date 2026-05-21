"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { LOTTERY_CONFIG, LOTTERY_TYPES } from "@/app/lib/lottery-config";
import { VIETLOTT_DATA_SOURCES } from "@/app/lib/vietlott-data-config";
import { runRollingBacktest } from "@/app/lib/backtesting-advanced";
import { buildMongoSummary, getMongoSchema } from "@/app/lib/mongodb-info";
import { summarizeQuality, validateCrawlBatch } from "@/app/lib/data-quality";
import { evaluatePrizeTier } from "@/app/lib/prize-rules";
import { comparePredictionToActual, confidenceFromScore, generatePredictions, updatePerformance } from "@/app/lib/prediction-engine";
import { scoreCoverage, summarizeCoverage } from "@/app/lib/coverage-optimizer";
import { addPrediction, createInitialSnapshot, mergeDraws, readSnapshotFromStorage, subscribeSnapshot, writeSnapshotToStorage } from "@/app/lib/storage";
import { average, createId, formatDate, formatDisplayDate, round, sum, uniqueSorted } from "@/app/lib/number-utils";
import type {
  CrawlStatus,
  DashboardSnapshot,
  DrawRecord,
  LotteryType,
  PredictionSet,
  PurchasedSet,
} from "@/app/lib/types";

const importableLotteryTypes = Object.keys(VIETLOTT_DATA_SOURCES) as LotteryType[];

const currencyFormatter = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("vi-VN");
const tabs = ["Prediction", "Purchased", "Analytics", "System"] as const;
type TabKey = (typeof tabs)[number];

interface PurchaseDraft {
  targetDrawDate: string;
  numbersText: string;
  ticketPrice: number;
  reason: string;
  predictionId: string;
}

function getNextDrawDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return formatDate(date);
}

function buildTargetDate(draws: DrawRecord[], lotteryType: LotteryType) {
  const config = LOTTERY_CONFIG[lotteryType];
  const latest = [...draws].sort((a, b) => b.drawDate.localeCompare(a.drawDate))[0];
  if (!latest) return getNextDrawDate();

  const date = new Date(`${latest.drawDate}T00:00:00.000Z`);
  date.setDate(date.getDate() + 7);
  const dayIndex = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  if (config.drawDays.length > 0 && !config.drawDays.includes(dayIndex)) {
    date.setDate(date.getDate() + 1);
  }
  return formatDate(date);
}

function confidenceClass(score: number) {
  if (score >= 0.75) return "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30";
  if (score >= 0.55) return "bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30";
  return "bg-slate-500/15 text-slate-200 ring-1 ring-slate-400/30";
}

function formatJackpot(draw?: DrawRecord) {
  if (!draw) return "No draw yet";
  const values = Object.values(draw.jackpotData ?? {}).filter((value) => value !== null && value !== undefined && value !== "");
  if (!values.length) return "Jackpot not published";
  return values.map((value) => (typeof value === "number" ? currencyFormatter.format(value) : String(value))).join(" | ");
}

function parseNumbers(input: string, maxNumber: number) {
  const numbers = input.match(/\b\d{1,2}\b/g)?.map(Number) ?? [];
  return uniqueSorted(numbers.filter((value) => value >= 1 && value <= maxNumber));
}

function analyzeDraws(draws: DrawRecord[], lotteryType: LotteryType) {
  const config = LOTTERY_CONFIG[lotteryType];
  const frequency = new Map<number, number>();
  const sums: number[] = [];
  const oddCounts: number[] = [];
  const bandCounts = { low: 0, mid: 0, high: 0 };
  const minSum = config.pickCount * 1;
  const maxSum = config.pickCount * config.maxNumber;
  const lowThreshold = minSum + (maxSum - minSum) / 3;
  const midThreshold = minSum + ((maxSum - minSum) * 2) / 3;

  for (const draw of draws) {
    const total = sum(draw.numbers);
    sums.push(total);
    oddCounts.push(draw.numbers.filter((number) => number % 2 === 1).length);
    for (const number of draw.numbers) {
      frequency.set(number, (frequency.get(number) ?? 0) + 1);
    }
    if (total <= lowThreshold) bandCounts.low += 1;
    else if (total <= midThreshold) bandCounts.mid += 1;
    else bandCounts.high += 1;
  }

  const allNumbers = Array.from({ length: config.maxNumber }, (_, index) => ({
    number: index + 1,
    count: frequency.get(index + 1) ?? 0,
  }));

  return {
    hotNumbers: [...allNumbers].sort((a, b) => b.count - a.count || a.number - b.number).slice(0, 5),
    coldNumbers: [...allNumbers].sort((a, b) => a.count - b.count || a.number - b.number).slice(0, 5),
    averageOdd: draws.length ? round(average(oddCounts), 2) : 0,
    averageEven: draws.length ? round(config.pickCount - average(oddCounts), 2) : 0,
    averageSum: draws.length ? round(average(sums), 2) : 0,
    bandCounts,
    recentDraws: draws.slice(0, 5).map((draw) => ({
      drawDate: draw.drawDate,
      sum: sum(draw.numbers),
      odd: draw.numbers.filter((number) => number % 2 === 1).length,
      even: draw.numbers.filter((number) => number % 2 === 0).length,
    })),
  };
}

function evaluatePurchase(purchase: PurchasedSet, actualDraw?: DrawRecord) {
  if (!actualDraw) {
    return { matchCount: 0, prizeAmount: 0, tier: null, isWinning: false };
  }

  const matchCount = purchase.selectedNumbers.filter((number) => actualDraw.numbers.includes(number)).length;
  const prize = evaluatePrizeTier({
    lotteryType: purchase.lotteryType,
    predictedNumbers: purchase.selectedNumbers,
    actualDraw,
  });

  return {
    matchCount,
    prizeAmount: prize.prizeAmount,
    tier: prize.tier,
    isWinning: prize.isWinning,
  };
}

export default function Dashboard() {
  const snapshot = useSyncExternalStore(subscribeSnapshot, readSnapshotFromStorage, createInitialSnapshot);
  const [activeTab, setActiveTab] = useState<TabKey>("Prediction");
  const [selectedLotteryType, setSelectedLotteryType] = useState<LotteryType>("mega645");
  const [predictionCount, setPredictionCount] = useState(5);
  const [historyWindow, setHistoryWindow] = useState(6);
  const [crawlStatus, setCrawlStatus] = useState<CrawlStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready.");
  const [purchaseStatus, setPurchaseStatus] = useState("No purchase saved yet.");
  const [purchaseRecords, setPurchaseRecords] = useState<PurchasedSet[]>([]);
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft>({
    targetDrawDate: getNextDrawDate(),
    numbersText: "",
    ticketPrice: 10000,
    reason: "",
    predictionId: "",
  });
  const [analysisFromDate, setAnalysisFromDate] = useState("2025-01-01");
  const [analysisToDate, setAnalysisToDate] = useState(formatDate(new Date()));
  const [trainWindow, setTrainWindow] = useState(8);
  const [testWindow, setTestWindow] = useState(6);
  const [mongoStatus, setMongoStatus] = useState("MongoDB not checked yet.");
  const [mongoTestStatus, setMongoTestStatus] = useState("Connection test not run.");
  const [mongoTestLoading, setMongoTestLoading] = useState(false);
  const [publishedHistory, setPublishedHistory] = useState<DrawRecord[]>([]);
  const [publishedHistoryStatus, setPublishedHistoryStatus] = useState("Loading latest published history...");

  const currentConfig = LOTTERY_CONFIG[selectedLotteryType];
  const selectedDraws = useMemo(
    () => snapshot.draws.filter((draw) => draw.lotteryType === selectedLotteryType).sort((a, b) => b.drawDate.localeCompare(a.drawDate)),
    [snapshot.draws, selectedLotteryType],
  );
  const selectedDrawsChronological = useMemo(
    () => [...selectedDraws].sort((a, b) => a.drawDate.localeCompare(b.drawDate)),
    [selectedDraws],
  );
  const selectedPredictions = useMemo(
    () => snapshot.predictions.filter((prediction) => prediction.lotteryType === selectedLotteryType).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)),
    [snapshot.predictions, selectedLotteryType],
  );
  const selectedPurchased = useMemo(
    () => purchaseRecords.filter((purchase) => purchase.lotteryType === selectedLotteryType).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [purchaseRecords, selectedLotteryType],
  );

  const latestDraw = selectedDraws[0];
  const latestPrediction = selectedPredictions[0];
  const nextDrawDate = buildTargetDate(selectedDraws, selectedLotteryType);
  const predictionBestSet = latestPrediction?.predictedSets[0];
  const predictionCoverage = predictionBestSet
    ? scoreCoverage(predictionBestSet.numbers, selectedDraws, selectedLotteryType).coverageScore
    : 0;
  const predictionCoverageSummary = predictionBestSet
    ? summarizeCoverage([predictionBestSet])
    : "Generate a prediction to see coverage.";
  const trendStats = useMemo(() => analyzeDraws(selectedDraws, selectedLotteryType), [selectedDraws, selectedLotteryType]);
  const qualityReport = useMemo(
    () =>
      validateCrawlBatch({
        lotteryType: selectedLotteryType,
        records: selectedDraws.slice(0, Math.min(5, selectedDraws.length)),
        config: currentConfig,
        existingDraws: selectedDraws.slice(5),
      }),
    [currentConfig, selectedDraws, selectedLotteryType],
  );
  const filteredAnalyticsDraws = useMemo(
    () => selectedDraws.filter((draw) => draw.drawDate >= analysisFromDate && draw.drawDate <= analysisToDate),
    [selectedDraws, analysisFromDate, analysisToDate],
  );
  const rollingBacktest = useMemo(() => {
    if (filteredAnalyticsDraws.length <= trainWindow) return null;
    return runRollingBacktest({
      lotteryType: selectedLotteryType,
      draws: filteredAnalyticsDraws,
      performance: snapshot.performance,
      trainWindow,
      testWindow,
    });
  }, [filteredAnalyticsDraws, selectedLotteryType, snapshot.performance, trainWindow, testWindow]);
  const patternPerformance = Object.entries(snapshot.performance.patternStats).sort((a, b) => b[1].edge - a[1].edge);
  const winningPurchases = selectedPurchased.filter((purchase) => evaluatePurchase(purchase, latestDraw).isWinning).length;

  useEffect(() => {
    let cancelled = false;
    async function loadPurchased() {
      try {
        const response = await fetch("/api/purchase");
        const payload = (await response.json()) as { purchasedSets?: PurchasedSet[]; error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? `Load failed ${response.status}`);
        }
        if (!cancelled) setPurchaseRecords(payload.purchasedSets ?? []);
      } catch (error) {
        if (!cancelled) setPurchaseStatus(error instanceof Error ? error.message : "Failed to load purchased numbers.");
      }
    }
    void loadPurchased();
    return () => {
      cancelled = true;
    };
  }, []);

  function saveSnapshot(nextSnapshot: DashboardSnapshot) {
    writeSnapshotToStorage(nextSnapshot);
  }

  async function refreshPurchased() {
    try {
      const response = await fetch("/api/purchase");
      const payload = (await response.json()) as { purchasedSets?: PurchasedSet[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Load failed ${response.status}`);
      }
      setPurchaseRecords(payload.purchasedSets ?? []);
      setPurchaseStatus(`Loaded ${payload.purchasedSets?.length ?? 0} purchased records.`);
    } catch (error) {
      setPurchaseStatus(error instanceof Error ? error.message : "Failed to load purchased numbers.");
    }
  }
  const loadPublishedHistory = useCallback(
    async (lotteryType: LotteryType) => {
      setPublishedHistoryStatus(`Loading latest published history for ${LOTTERY_CONFIG[lotteryType].name}...`);

      try {
        const response = await fetch(`/api/crawl?lotteryType=${lotteryType}`);
        if (!response.ok) {
          throw new Error(`History fetch failed ${response.status}`);
        }

        const payload = (await response.json()) as { records?: DrawRecord[] };
        const records = payload.records ?? [];
        setPublishedHistory(records.slice(0, 6));
        setPublishedHistoryStatus(
          records.length
            ? `Mongo history loaded for ${LOTTERY_CONFIG[lotteryType].name}.`
            : `No Mongo history found for ${LOTTERY_CONFIG[lotteryType].name}.`,
        );
      } catch (error) {
        setPublishedHistory(selectedDraws.slice(0, 6));
        setPublishedHistoryStatus(
          error instanceof Error
            ? `Using local snapshot fallback: ${error.message}`
            : "Using local snapshot fallback.",
        );
      }
    },
    [selectedDraws],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPublishedHistory(selectedLotteryType);
  }, [loadPublishedHistory, selectedLotteryType]);

  async function handleImportFromGitHub() {
    setCrawlStatus("running");
    setStatusMessage("Importing published data from GitHub...");

    try {
      const importedRecords: DrawRecord[] = [];
      const summaries: string[] = [];

      for (const lotteryType of importableLotteryTypes) {
        const response = await fetch(`/api/import-vietlott-data?lotteryType=${lotteryType}`, {
          method: "POST",
        });

        const payload = (await response.json()) as {
          ok?: boolean;
          inserted?: number;
          updated?: number;
          skipped?: number;
          latestDrawDate?: string | null;
          records?: DrawRecord[];
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? `Import failed ${response.status}`);
        }

        importedRecords.push(...(payload.records ?? []));
        summaries.push(
          `${LOTTERY_CONFIG[lotteryType].name}: +${payload.inserted ?? 0} inserted, ${payload.updated ?? 0} updated, ${payload.skipped ?? 0} skipped${payload.latestDrawDate ? `, latest ${payload.latestDrawDate}` : ""}`,
        );
      }

      const merged = mergeDraws(snapshot.draws, importedRecords);
      let nextSnapshot: DashboardSnapshot = { ...snapshot, draws: merged.draws };
      const latestMergedDraw = [...merged.draws]
        .filter((draw) => draw.lotteryType === selectedLotteryType)
        .sort((a, b) => b.drawDate.localeCompare(a.drawDate))[0];
      const pendingPrediction = nextSnapshot.predictions.find(
        (prediction) => prediction.lotteryType === selectedLotteryType && prediction.status === "pending",
      );

      if (pendingPrediction && latestMergedDraw) {
        const evaluated = comparePredictionToActual(pendingPrediction, latestMergedDraw.numbers);
        nextSnapshot = {
          ...nextSnapshot,
          predictions: addPrediction(nextSnapshot.predictions, evaluated),
          performance: updatePerformance(nextSnapshot.performance, evaluated),
        };

        void fetch("/api/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prediction: evaluated, actualDraw: latestMergedDraw }),
        });
      }

      saveSnapshot(nextSnapshot);
      setCrawlStatus("success");
      setStatusMessage(
        summaries.length
          ? `GitHub import complete. ${summaries.join(" | ")}`
          : "GitHub import complete. No records returned.",
      );

      await loadPublishedHistory(selectedLotteryType);

      if (latestMergedDraw) {
        await handleEvaluatePurchasedNumbers(latestMergedDraw);
      }
    } catch (error) {
      setCrawlStatus("error");
      setStatusMessage(error instanceof Error ? error.message : "GitHub import failed.");
    }
  }

  function handleGeneratePrediction() {
    const history = selectedDrawsChronological.slice(Math.max(0, selectedDrawsChronological.length - historyWindow));
    const prediction = generatePredictions({
      lotteryType: selectedLotteryType,
      history,
      count: predictionCount,
      performance: snapshot.performance,
      targetDrawDate: nextDrawDate,
    });

    saveSnapshot({
      ...snapshot,
      predictions: addPrediction(snapshot.predictions, prediction),
    });

    void fetch("/api/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prediction }),
    });

    setStatusMessage(`Generated ${prediction.predictedSets.length} sets for ${formatDisplayDate(prediction.targetDrawDate)}.`);
    setActiveTab("Prediction");
    setPurchaseDraft((current) => ({
      ...current,
      targetDrawDate: prediction.targetDrawDate,
      predictionId: prediction.id,
      numbersText: prediction.predictedSets[0]?.numbers.join(" ") ?? current.numbersText,
    }));
  }

  function handleUsePrediction(candidate: PredictionSet) {
    if (!latestPrediction) return;
    setPurchaseDraft((current) => ({
      ...current,
      targetDrawDate: latestPrediction.targetDrawDate || nextDrawDate,
      predictionId: latestPrediction.id,
      numbersText: candidate.numbers.join(" "),
      reason: candidate.reasons[0] ?? current.reason,
    }));
    setActiveTab("Purchased");
    setPurchaseStatus("Prediction copied to purchase form.");
  }

  function handleCompareLatestPrediction(actualDraw = latestDraw) {
    const pending = snapshot.predictions.find(
      (prediction) => prediction.lotteryType === selectedLotteryType && prediction.status === "pending",
    );

    if (!pending || !actualDraw) {
      setStatusMessage("No pending prediction or no actual draw to compare.");
      return;
    }

    const evaluated = comparePredictionToActual(pending, actualDraw.numbers);
    saveSnapshot({
      ...snapshot,
      predictions: addPrediction(snapshot.predictions, evaluated),
      performance: updatePerformance(snapshot.performance, evaluated),
    });

    void fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prediction: evaluated, actualDraw }),
    });

    setStatusMessage(`Compared the latest prediction with ${formatDisplayDate(actualDraw.drawDate)}.`);
  }

  async function handleSavePurchase() {
    const numbers = parseNumbers(purchaseDraft.numbersText, currentConfig.maxNumber);
    if (numbers.length !== currentConfig.pickCount) {
      setPurchaseStatus(`Please enter exactly ${currentConfig.pickCount} numbers.`);
      return;
    }

    const purchasedSet: PurchasedSet = {
      id: createId("buy", purchaseDraft.targetDrawDate, `${selectedLotteryType}-${numbers.join("")}`),
      lotteryType: selectedLotteryType,
      targetDrawDate: purchaseDraft.targetDrawDate,
      predictionId: purchaseDraft.predictionId || latestPrediction?.id,
      selectedNumbers: numbers,
      reason: purchaseDraft.reason.trim() || undefined,
      ticketPrice: purchaseDraft.ticketPrice,
      totalCost: purchaseDraft.ticketPrice,
      createdAt: new Date().toISOString(),
    };

    try {
      const response = await fetch("/api/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchasedSet }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `Save failed ${response.status}`);
      }

      setPurchaseRecords((current) => [purchasedSet, ...current.filter((item) => item.id !== purchasedSet.id)]);
      setPurchaseStatus(`Saved purchase for ${formatDisplayDate(purchasedSet.targetDrawDate)}.`);
      setActiveTab("Purchased");
    } catch (error) {
      setPurchaseStatus(error instanceof Error ? error.message : "Failed to save purchase.");
    }
  }

  async function handleEvaluatePurchasedNumbers(actualDraw = latestDraw) {
    if (!actualDraw) {
      setPurchaseStatus("No actual draw available to evaluate.");
      return;
    }

    const purchasesToCheck = selectedPurchased.filter((purchase) => purchase.targetDrawDate <= actualDraw.drawDate);
    if (!purchasesToCheck.length) {
      setPurchaseStatus("No purchased numbers are ready for evaluation.");
      return;
    }

    await Promise.all(
      purchasesToCheck.map((purchase) =>
        fetch("/api/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purchasedSet: purchase, actualDraw }),
        }),
      ),
    );

    setPurchaseStatus(`Evaluated ${purchasesToCheck.length} purchased sets against ${formatDisplayDate(actualDraw.drawDate)}.`);
  }

  async function handleSyncMongoSnapshot() {
    try {
      const response = await fetch("/api/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Sync failed ${response.status}`);
      setMongoStatus(`Snapshot synced. ${buildMongoSummary(snapshot)}`);
    } catch (error) {
      setMongoStatus(error instanceof Error ? error.message : "Sync failed.");
    }
  }

  async function handleLoadFromMongoSnapshot() {
    try {
      const response = await fetch("/api/snapshot");
      const payload = (await response.json()) as { snapshot?: DashboardSnapshot; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Load failed ${response.status}`);

      if (payload.snapshot) {
        saveSnapshot(payload.snapshot);
        setMongoStatus("Snapshot loaded from MongoDB.");
        setStatusMessage("Loaded data from MongoDB into the dashboard.");
      }
      await refreshPurchased();
    } catch (error) {
      setMongoStatus(error instanceof Error ? error.message : "Load failed.");
    }
  }

  async function handleTestMongoConnection() {
    setMongoTestLoading(true);
    setMongoTestStatus("Testing MongoDB connection...");

    try {
      const response = await fetch("/api/test-db");
      const payload = (await response.json()) as { ok?: boolean; message?: string; latencyMs?: number };
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? `Test failed ${response.status}`);
      setMongoTestStatus(`${payload.message ?? "MongoDB connected."} Latency: ${payload.latencyMs ?? 0}ms`);
    } catch (error) {
      setMongoTestStatus(error instanceof Error ? error.message : "MongoDB test failed.");
    } finally {
      setMongoTestLoading(false);
    }
  }

  async function handleSaveAnalytics() {
    try {
      const response = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backtest: rollingBacktest, quality: qualityReport, snapshot }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `Save failed ${response.status}`);
      setMongoStatus("Analytics saved to MongoDB.");
    } catch (error) {
      setMongoStatus(error instanceof Error ? error.message : "Failed to save analytics.");
    }
  }

  const predictionLabel = latestPrediction ? `${latestPrediction.predictedSets.length} sets · ${latestPrediction.status}` : "No predictions yet";
  const bestPrediction = latestPrediction?.predictedSets[0];
  const bestPredictionCoverage = bestPrediction ? scoreCoverage(bestPrediction.numbers, selectedDraws, selectedLotteryType).coverageScore : 0;

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-950 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(38,130,255,0.24),_transparent_36%),radial-gradient(circle_at_top_right,_rgba(250,193,64,0.16),_transparent_30%),linear-gradient(180deg,_rgba(8,15,28,1),_rgba(8,12,20,0.94))]" />
      <section className="relative mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
        <header className="grid gap-4 rounded-[2rem] border border-white/10 bg-white/6 p-5 backdrop-blur-xl lg:grid-cols-[1.3fr_0.9fr]">
          <div className="space-y-4">
            <div className="inline-flex rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-100">Lottery Recommendation Engine</div>
            <div>
              <p className="text-sm uppercase tracking-[0.35em] text-sky-200/80">Prediction first</p>
              <h1 className="mt-2 text-3xl font-semibold sm:text-5xl">A simpler flow: generate, buy, compare, and review.</h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base">
                Main screen: current draw, current jackpot, suggested numbers, purchased numbers, and result. Analytics keeps the technical details.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: "Draws", value: numberFormatter.format(selectedDraws.length) },
                { label: "Predictions", value: numberFormatter.format(selectedPredictions.length) },
                { label: "Purchased", value: numberFormatter.format(selectedPurchased.length) },
                { label: "Coverage", value: `${round((selectedDraws.length / Math.max(1, snapshot.draws.length)) * 100, 1)}%` },
              ].map((item) => (
                <div key={item.label} className="rounded-2xl border border-white/8 bg-white/5 p-3">
                  <div className="text-xs uppercase tracking-[0.25em] text-slate-400">{item.label}</div>
                  <div className="mt-1 text-2xl font-semibold">{item.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 rounded-[1.5rem] border border-white/10 bg-slate-950/50 p-4 text-sm text-slate-200">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Selected lottery</span>
              <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-200 ring-1 ring-emerald-400/20">{currentConfig.name}</span>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
              <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Current draw</div>
              <div className="mt-2 text-lg font-semibold">{latestDraw ? formatDisplayDate(latestDraw.drawDate) : "Waiting for result"}</div>
              <div className="mt-2 text-sm text-slate-300">{formatJackpot(latestDraw)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/8 bg-white/5 p-3">
                <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Next draw</div>
                <div className="mt-1 text-lg font-semibold">{nextDrawDate}</div>
              </div>
              <div className="rounded-2xl border border-white/8 bg-white/5 p-3">
                <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Model</div>
                <div className="mt-1 text-lg font-semibold">v{snapshot.performance.version ?? "1.0.0"}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={handleImportFromGitHub} className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold">
                Update Data From GitHub
              </button>
              <button type="button" onClick={handleGeneratePrediction} className="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950">Generate recommendation</button>
              <button type="button" onClick={() => setActiveTab("Purchased")} className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold">Save purchased numbers</button>
              <button type="button" onClick={() => handleCompareLatestPrediction()} className="rounded-2xl border border-emerald-400/30 px-4 py-3 text-sm font-semibold text-emerald-100">Compare latest result</button>
            </div>
            <div className={`rounded-2xl border px-4 py-3 text-sm ${crawlStatus === "success" ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100" : crawlStatus === "error" ? "border-rose-400/20 bg-rose-400/10 text-rose-100" : "border-white/8 bg-slate-900/70 text-slate-300"}`}>
              {statusMessage}
            </div>
          </div>
        </header>

        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {LOTTERY_TYPES.map((type) => {
            const config = LOTTERY_CONFIG[type];
            const active = selectedLotteryType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setSelectedLotteryType(type);
                  setPurchaseDraft((current) => ({
                    ...current,
                    targetDrawDate: buildTargetDate(
                      snapshot.draws.filter((draw) => draw.lotteryType === type),
                      type,
                    ),
                  }));
                }}
                className={`rounded-[1.5rem] border p-4 text-left ${active ? "border-cyan-400/50 bg-cyan-400/10" : "border-white/10 bg-slate-950/55"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">{config.name}</div>
                    <div className="text-sm text-slate-400">{config.notes}</div>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs ${active ? "bg-cyan-400 text-slate-950" : "bg-white/10 text-slate-200"}`}>{config.pickCount} picks</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
                  <div className="rounded-xl border border-white/8 bg-slate-900/60 p-2">Max: {config.maxNumber}</div>
                  <div className="rounded-xl border border-white/8 bg-slate-900/60 p-2">Bonus: {config.hasBonus ? "Yes" : "No"}</div>
                  <div className="col-span-2 rounded-xl border border-white/8 bg-slate-900/60 p-2">Days: {config.drawDays.join(", ") || "Manual"}</div>
                </div>
              </button>
            );
          })}
        </div>

        <nav className="flex flex-wrap gap-2 rounded-3xl border border-white/10 bg-slate-950/45 p-2 backdrop-blur">
          {tabs.map((tab) => (
            <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={`rounded-2xl px-4 py-2 text-sm font-medium ${activeTab === tab ? "bg-cyan-400 text-slate-950" : "text-slate-300"}`}>
              {tab}
            </button>
          ))}
          <div className="ml-auto hidden items-center gap-2 lg:flex"><div className="text-xs uppercase tracking-[0.25em] text-slate-500">{purchaseStatus}</div></div>
        </nav>

        {activeTab === "Prediction" && (
          <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="lg:col-span-2 rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">Published history</h2>
                  <p className="mt-1 text-sm text-slate-400">Recent published draws for {currentConfig.name}.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-white/8 bg-white/5 px-3 py-1 text-xs text-slate-300">
                    {publishedHistoryStatus}
                  </span>
                  <button
                    type="button"
                    onClick={() => void loadPublishedHistory(selectedLotteryType)}
                    className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold"
                  >
                    Reload published history
                  </button>
                </div>
              </div>
              <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
                {publishedHistory.length ? (
                  publishedHistory.map((draw) => (
                    <div key={draw.drawId} className="min-w-[220px] rounded-3xl border border-white/8 bg-white/5 p-4">
                      <div className="text-xs uppercase tracking-[0.25em] text-slate-400">
                        {formatDisplayDate(draw.drawDate)}
                      </div>
                      <div className="mt-2 text-lg font-semibold">
                        {draw.numbers.join(" - ")}
                      </div>
                      <div className="mt-2 text-xs text-slate-300">
                        {formatJackpot(draw)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-3xl border border-dashed border-white/15 bg-white/4 p-8 text-center text-slate-400">
                    No published history yet.
                  </div>
                )}
              </div>
            </div>

            <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">Main recommendation</h2>
                  <p className="mt-1 text-sm text-slate-400">Generate a set and push it to the purchase form.</p>
                </div>
                <div className="rounded-full border border-white/8 bg-white/5 px-3 py-2 text-xs text-slate-300">Coverage: {round(predictionCoverage * 100, 1)}%</div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  Recommendation sets
                  <input type="number" min={1} max={20} value={predictionCount} onChange={(event) => setPredictionCount(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  History window
                  <input type="number" min={3} max={20} value={historyWindow} onChange={(event) => setHistoryWindow(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <div className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  Next draw
                  <div className="mt-2 text-lg font-semibold text-white">{nextDrawDate}</div>
                </div>
              </div>
              {bestPrediction ? (
                <div className="mt-4 rounded-3xl border border-cyan-400/20 bg-cyan-400/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.25em] text-cyan-100/70">Latest prediction</div>
                      <div className="mt-1 text-2xl font-semibold">{bestPrediction.numbers.join(" - ")}</div>
                    </div>
                    <div className={`rounded-full px-3 py-1 text-xs font-medium ${confidenceClass(bestPrediction.score)}`}>{confidenceFromScore(bestPrediction.score)}</div>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3 text-sm text-slate-200">
                    <div className="rounded-2xl border border-white/8 bg-slate-950/45 p-3">Score: {bestPrediction.score}</div>
                    <div className="rounded-2xl border border-white/8 bg-slate-950/45 p-3">Coverage: {bestPrediction.coverageScore ?? 0}</div>
                    <div className="rounded-2xl border border-white/8 bg-slate-950/45 p-3">Target: {latestPrediction ? formatDisplayDate(latestPrediction.targetDrawDate) : "-"}</div>
                  </div>
                  <div className="mt-3 text-sm leading-6 text-slate-200">{predictionCoverageSummary}</div>
                  <div className="mt-2 text-xs uppercase tracking-[0.25em] text-cyan-100/70">Coverage score: {bestPredictionCoverage}</div>
                </div>
              ) : (
                <div className="mt-4 rounded-3xl border border-dashed border-white/15 bg-white/4 p-8 text-center text-slate-400">No recommendation yet. Generate one to start.</div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={handleGeneratePrediction} className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-950">Generate again</button>
                <button type="button" onClick={() => bestPrediction && handleUsePrediction(bestPrediction)} disabled={!bestPrediction} className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold disabled:opacity-50">Use this set</button>
                <button type="button" onClick={() => handleCompareLatestPrediction()} className="rounded-2xl border border-emerald-400/30 px-4 py-3 text-sm font-semibold text-emerald-100">Compare latest result</button>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {latestPrediction?.predictedSets.length ? (
                  latestPrediction.predictedSets.map((candidate, index) => (
                    <div key={`${candidate.numbers.join("-")}-${index}`} className="rounded-3xl border border-white/8 bg-white/5 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Set {index + 1}</div>
                          <div className="mt-1 text-xl font-semibold">{candidate.numbers.join(" - ")}</div>
                        </div>
                        <div className="text-right text-sm text-slate-300">
                          <div>Score: {candidate.score}</div>
                          <div>Coverage: {candidate.coverageScore ?? 0}</div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {candidate.numbers.map((number) => (
                          <span key={number} className="rounded-full border border-white/8 bg-slate-900/70 px-3 py-1 text-sm text-white">{number}</span>
                        ))}
                      </div>
                      <div className="mt-3 text-sm leading-6 text-slate-300">{candidate.reasons.length ? candidate.reasons.join(" | ") : "Balanced set with no dominant pattern."}</div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => handleUsePrediction(candidate)} className="rounded-2xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950">Use this set</button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-3xl border border-dashed border-white/15 bg-white/4 p-8 text-center text-slate-400">No recommendation sets yet.</div>
                )}
              </div>
            </article>

            <aside className="space-y-4">
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <h3 className="text-lg font-semibold">Side analysis</h3>
                <div className="mt-4 space-y-3 text-sm text-slate-300">
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Current draw: <span className="text-white">{latestDraw ? formatDisplayDate(latestDraw.drawDate) : "Waiting"}</span>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Jackpot: <span className="text-white">{formatJackpot(latestDraw)}</span>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Model status: <span className="text-white">{predictionLabel}</span>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Latest message: <span className="text-white">{statusMessage}</span>
                  </div>
                </div>
              </article>

              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <h3 className="text-lg font-semibold">Published trend</h3>
                <div className="mt-4 grid gap-3 text-sm text-slate-300">
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Hot numbers: <span className="text-white">{trendStats.hotNumbers.map((item) => item.number).join(", ")}</span>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Cold numbers: <span className="text-white">{trendStats.coldNumbers.map((item) => item.number).join(", ")}</span>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Odd / Even: <span className="text-white">{trendStats.averageOdd} / {trendStats.averageEven}</span>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-white/5 p-4">
                    Sum range: <span className="text-white">{trendStats.averageSum}</span>
                  </div>
                </div>
              </article>

              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <h3 className="text-lg font-semibold">Selected config</h3>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-300">
                  <div className="rounded-xl border border-white/8 bg-white/5 p-3">Max: {currentConfig.maxNumber}</div>
                  <div className="rounded-xl border border-white/8 bg-white/5 p-3">Pick: {currentConfig.pickCount}</div>
                  <div className="col-span-2 rounded-xl border border-white/8 bg-white/5 p-3">Source: {currentConfig.sourceFormat}</div>
                  <div className="col-span-2 rounded-xl border border-white/8 bg-white/5 p-3">Days: {currentConfig.drawDays.join(", ") || "Manual"}</div>
                </div>
              </article>
            </aside>
          </section>
        )}

        {activeTab === "Purchased" && (
          <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
            <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">Purchased numbers</h2>
                  <p className="mt-1 text-sm text-slate-400">Save what you buy and compare it with the latest result.</p>
                </div>
                <button type="button" onClick={refreshPurchased} className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold">Refresh</button>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  Target draw date
                  <input type="date" value={purchaseDraft.targetDrawDate} onChange={(event) => setPurchaseDraft((current) => ({ ...current, targetDrawDate: event.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  Ticket price
                  <input type="number" min={0} step={1000} value={purchaseDraft.ticketPrice} onChange={(event) => setPurchaseDraft((current) => ({ ...current, ticketPrice: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300 sm:col-span-2">
                  Numbers bought
                  <textarea value={purchaseDraft.numbersText} onChange={(event) => setPurchaseDraft((current) => ({ ...current, numbersText: event.target.value }))} placeholder={`Enter ${currentConfig.pickCount} numbers separated by spaces or commas`} className="mt-2 min-h-28 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300 sm:col-span-2">
                  Note
                  <input type="text" value={purchaseDraft.reason} onChange={(event) => setPurchaseDraft((current) => ({ ...current, reason: event.target.value }))} placeholder="Why did you buy this set?" className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={handleSavePurchase} className="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950">Save purchased numbers</button>
                <button type="button" onClick={() => handleEvaluatePurchasedNumbers()} className="rounded-2xl border border-emerald-400/30 px-4 py-3 text-sm font-semibold text-emerald-100">Compare with latest result</button>
                <button type="button" onClick={() => setPurchaseDraft((current) => ({ ...current, numbersText: "", reason: "" }))} className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold">Clear form</button>
              </div>

              <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300">{purchaseStatus}</div>
            </article>

            <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">Saved purchases</h3>
                  <p className="mt-1 text-sm text-slate-400">Grouped by target draw date and checked against the latest result.</p>
                </div>
                <div className="text-sm text-slate-400">{selectedPurchased.length} items | {winningPurchases} wins</div>
              </div>

              <div className="mt-4 space-y-3">
                {selectedPurchased.length ? selectedPurchased.map((purchase) => {
                  const result = evaluatePurchase(purchase, latestDraw);
                  return (
                    <div key={purchase.id} className="rounded-3xl border border-white/8 bg-white/5 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.25em] text-slate-400">{formatDisplayDate(purchase.targetDrawDate)}</div>
                          <div className="mt-1 text-lg font-semibold">{purchase.selectedNumbers.join(" - ")}</div>
                          <div className="mt-1 text-sm text-slate-400">{purchase.reason || "No note"}</div>
                        </div>
                        <div className="text-right text-sm text-slate-300">
                          <div>Ticket: {currencyFormatter.format(purchase.ticketPrice)}</div>
                          <div>Total: {currencyFormatter.format(purchase.totalCost)}</div>
                          <div className={result.isWinning ? "text-emerald-300" : "text-slate-400"}>
                            {latestDraw && purchase.targetDrawDate <= latestDraw.drawDate
                              ? result.isWinning
                                ? `WIN | ${result.tier ?? "Prize"}`
                                : `Checked | ${result.matchCount} matches`
                              : "Waiting for result"}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="rounded-3xl border border-dashed border-white/15 bg-white/4 p-8 text-center text-slate-400">No purchased numbers saved yet.</div>
                )}
              </div>
            </article>
          </section>
        )}

        {activeTab === "Analytics" && (
          <section className="space-y-4">
            <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold">Analytics</h2>
                  <p className="mt-1 text-sm text-slate-400">Technical details stay here, away from the main flow.</p>
                </div>
                <button type="button" onClick={handleSaveAnalytics} className="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950">Save analytics</button>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  From
                  <input type="date" value={analysisFromDate} onChange={(event) => setAnalysisFromDate(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  To
                  <input type="date" value={analysisToDate} onChange={(event) => setAnalysisToDate(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  Train window
                  <input type="number" min={2} max={20} value={trainWindow} onChange={(event) => setTrainWindow(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
                <label className="rounded-2xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300">
                  Test window
                  <input type="number" min={1} max={20} value={testWindow} onChange={(event) => setTestWindow(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-white outline-none" />
                </label>
              </div>
            </article>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Hot numbers</div>
                <div className="mt-3 flex flex-wrap gap-2">{trendStats.hotNumbers.map((item) => <span key={item.number} className="rounded-full border border-white/8 bg-white/5 px-3 py-1 text-sm">{item.number} ({item.count})</span>)}</div>
              </article>
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Cold numbers</div>
                <div className="mt-3 flex flex-wrap gap-2">{trendStats.coldNumbers.map((item) => <span key={item.number} className="rounded-full border border-white/8 bg-white/5 px-3 py-1 text-sm">{item.number} ({item.count})</span>)}</div>
              </article>
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Odd / Even</div>
                <div className="mt-3 space-y-2 text-sm text-slate-300"><div>Average odd: <span className="text-white">{trendStats.averageOdd}</span></div><div>Average even: <span className="text-white">{trendStats.averageEven}</span></div></div>
              </article>
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <div className="text-xs uppercase tracking-[0.25em] text-slate-400">Sum range</div>
                <div className="mt-3 space-y-2 text-sm text-slate-300"><div>Average sum: <span className="text-white">{trendStats.averageSum}</span></div><div>Low / Mid / High: <span className="text-white">{trendStats.bandCounts.low} / {trendStats.bandCounts.mid} / {trendStats.bandCounts.high}</span></div></div>
              </article>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <h3 className="text-lg font-semibold">Backtest summary</h3>
                <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300">{rollingBacktest ? rollingBacktest.summary : "Not enough data for rolling backtest."}</div>
                {rollingBacktest && <div className="mt-4 grid grid-cols-3 gap-2 text-sm text-slate-300"><div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">Model: <span className="text-white">{rollingBacktest.modelAverageMatch}</span></div><div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">Random: <span className="text-white">{rollingBacktest.randomAverageMatch}</span></div><div className="rounded-xl border border-white/8 bg-slate-900/60 p-3">Edge: <span className="text-white">{rollingBacktest.edge}</span></div></div>}
              </article>
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <h3 className="text-lg font-semibold">Pattern performance</h3>
                <div className="mt-4 space-y-2">{patternPerformance.slice(0, 5).map(([name, stat]) => <div key={name} className="rounded-xl border border-white/8 bg-white/5 p-3 text-sm text-slate-300"><div className="flex items-center justify-between gap-3"><span className="text-white">{name}</span><span className={stat.edge >= 0 ? "text-emerald-300" : "text-rose-300"}>edge {stat.edge}</span></div><div className="mt-1 text-xs text-slate-400">used {stat.usedCount} | avg {stat.avgMatch} | random {stat.randomBaseline}</div></div>)}</div>
              </article>
            </div>

            <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <h3 className="text-lg font-semibold">Data quality</h3>
                <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300">{summarizeQuality(qualityReport)}</div>
                <div className="mt-3 space-y-2">{qualityReport.issues.slice(0, 4).map((issue) => <div key={`${issue.code}-${issue.message}`} className="rounded-xl border border-white/8 bg-slate-900/60 p-3 text-sm text-slate-300"><span className="font-semibold text-white">{issue.severity}</span> {issue.message}</div>)}</div>
              </article>
              <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
                <h3 className="text-lg font-semibold">History table</h3>
                <div className="mt-4 overflow-hidden rounded-2xl border border-white/8">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="bg-slate-900/80 text-slate-300"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Sum</th><th className="px-4 py-3">Odd</th><th className="px-4 py-3">Even</th></tr></thead>
                    <tbody className="divide-y divide-white/8 bg-slate-950/55 text-slate-200">
                      {trendStats.recentDraws.length ? trendStats.recentDraws.map((row) => <tr key={row.drawDate}><td className="px-4 py-3">{formatDisplayDate(row.drawDate)}</td><td className="px-4 py-3">{row.sum}</td><td className="px-4 py-3">{row.odd}</td><td className="px-4 py-3">{row.even}</td></tr>) : <tr><td className="px-4 py-6 text-center text-slate-400" colSpan={4}>No draw data in the selected range.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </article>
            </div>
          </section>
        )}

        {activeTab === "System" && (
          <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">System</h2><p className="mt-1 text-sm text-slate-400">MongoDB status, sync actions, and schema reference.</p></div><div className="rounded-full border border-white/8 bg-white/5 px-3 py-1 text-xs text-slate-300">{crawlStatus}</div></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300"><div className="text-xs uppercase tracking-[0.25em] text-slate-400">Mongo status</div><div className="mt-2 text-white">{mongoStatus}</div></div><div className="rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300"><div className="text-xs uppercase tracking-[0.25em] text-slate-400">Connection test</div><div className="mt-2 text-white">{mongoTestStatus}</div></div></div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={handleTestMongoConnection} disabled={mongoTestLoading} className="rounded-2xl border border-cyan-400/30 px-4 py-3 text-sm font-semibold text-cyan-100 disabled:opacity-60">{mongoTestLoading ? "Testing..." : "Test MongoDB Connection"}</button>
                <button type="button" onClick={handleImportFromGitHub} className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold">Update Data From GitHub</button>
                <button type="button" onClick={handleLoadFromMongoSnapshot} className="rounded-2xl border border-white/10 px-4 py-3 text-sm font-semibold">Load snapshot</button>
                <button type="button" onClick={handleSyncMongoSnapshot} className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-950">Sync snapshot</button>
                <button type="button" onClick={handleSaveAnalytics} className="rounded-2xl border border-emerald-400/30 px-4 py-3 text-sm font-semibold text-emerald-100">Save analytics</button>
              </div>
              <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300">{buildMongoSummary(snapshot)}</div>
            </article>
            <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5">
              <h3 className="text-lg font-semibold">Mongo schema</h3>
              <pre className="mt-4 overflow-x-auto rounded-2xl border border-white/8 bg-slate-950/80 p-4 text-xs leading-6 text-slate-200">{getMongoSchema()}</pre>
            </article>
            <article className="rounded-[1.75rem] border border-white/10 bg-slate-950/55 p-5 lg:col-span-2">
              <h3 className="text-lg font-semibold">Activity log</h3>
              <div className="mt-4 grid gap-3 md:grid-cols-3"><div className="rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300"><div className="text-xs uppercase tracking-[0.25em] text-slate-400">Last crawl</div><div className="mt-2 text-white">{latestDraw ? formatDisplayDate(latestDraw.drawDate) : "No crawl data"}</div></div><div className="rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300"><div className="text-xs uppercase tracking-[0.25em] text-slate-400">Latest prediction</div><div className="mt-2 text-white">{latestPrediction ? `${latestPrediction.predictedSets.length} sets` : "No prediction yet"}</div></div><div className="rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-slate-300"><div className="text-xs uppercase tracking-[0.25em] text-slate-400">Latest purchases</div><div className="mt-2 text-white">{selectedPurchased.length} saved | {winningPurchases} winning</div></div></div>
            </article>
          </section>
        )}
      </section>
    </main>
  );
}

