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
const dashboardNav = ["dashboard", "lottery-select", "purchased", "analytics", "settings"] as const;
type DashboardNavKey = (typeof dashboardNav)[number];

interface PurchaseDraft {
  targetDrawDate: string;
  numbersText: string;
  ticketPrice: number;
  reason: string;
  predictionId: string;
}

interface HistoryDraft {
  drawDate: string;
  numbersText: string;
  bonusText: string;
  jackpotText: string;
}

function getNextDrawDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return formatDate(date);
}

function getDrawDayIndex(date: Date) {
  return date.getUTCDay() === 0 ? 7 : date.getUTCDay();
}

function buildTargetDate(draws: DrawRecord[], lotteryType: LotteryType) {
  const config = LOTTERY_CONFIG[lotteryType];
  const latest = [...draws].sort((a, b) => b.drawDate.localeCompare(a.drawDate))[0];
  const today = new Date(`${formatDate(new Date())}T00:00:00.000Z`);

  if (!config.drawDays.length) {
    if (!latest) return getNextDrawDate();

    const fallback = new Date(`${latest.drawDate}T00:00:00.000Z`);
    fallback.setUTCDate(fallback.getUTCDate() + 1);
    return formatDate(fallback);
  }

  const date = latest ? new Date(`${latest.drawDate}T00:00:00.000Z`) : today;
  if (latest) {
    date.setUTCDate(date.getUTCDate() + 1);
  }

  if (date < today) {
    date.setTime(today.getTime());
  }

  for (let offset = 0; offset < 14; offset += 1) {
    if (config.drawDays.includes(getDrawDayIndex(date))) {
      return formatDate(date);
    }
    date.setUTCDate(date.getUTCDate() + 1);
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

function parseMoney(input: string) {
  const digits = input.replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
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
  const [activeNav, setActiveNav] = useState<DashboardNavKey>("lottery-select");
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
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = useState(false);
  const [historyDraft, setHistoryDraft] = useState<HistoryDraft>({
    drawDate: formatDate(new Date()),
    numbersText: "",
    bonusText: "",
    jackpotText: "",
  });

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
        const response = await fetch(`/api/import-vietlott-data?lotteryType=${lotteryType}&replace=true`, {
          method: "POST",
        });

        const payload = (await response.json()) as {
          ok?: boolean;
          deleted?: number;
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
          `${LOTTERY_CONFIG[lotteryType].name}: ${payload.deleted ?? 0} deleted, +${payload.inserted ?? 0} inserted, ${payload.skipped ?? 0} skipped${payload.latestDrawDate ? `, latest ${payload.latestDrawDate}` : ""}`,
        );
      }

      const replacedTypes = new Set<LotteryType>(importableLotteryTypes);
      const retainedDraws = snapshot.draws.filter((draw) => !replacedTypes.has(draw.lotteryType));
      const merged = mergeDraws(retainedDraws, importedRecords);
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

  function openHistoryDialog() {
    setHistoryDraft({
      drawDate: latestDraw?.drawDate ?? formatDate(new Date()),
      numbersText: latestDraw?.numbers.join(" ") ?? "",
      bonusText: latestDraw?.bonusNumbers.join(" ") ?? "",
      jackpotText: "",
    });
    setIsHistoryDialogOpen(true);
  }

  async function handleSaveManualHistory() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(historyDraft.drawDate)) {
      setPublishedHistoryStatus("Select a valid draw date.");
      return;
    }

    const numbers = parseNumbers(historyDraft.numbersText, currentConfig.maxNumber);
    if (numbers.length !== currentConfig.pickCount) {
      setPublishedHistoryStatus(`Enter exactly ${currentConfig.pickCount} result numbers.`);
      return;
    }

    const bonusNumbers = currentConfig.hasBonus
      ? parseNumbers(historyDraft.bonusText, currentConfig.maxNumber).slice(0, 1)
      : [];
    const jackpotAmount = parseMoney(historyDraft.jackpotText);
    const now = new Date().toISOString();
    const manualDraw: DrawRecord = {
      lotteryType: selectedLotteryType,
      drawDate: historyDraft.drawDate,
      drawId: createId(selectedLotteryType, historyDraft.drawDate, numbers.join("")),
      numbers,
      bonusNumbers,
      jackpotData: jackpotAmount === null ? {} : { [currentConfig.hasBonus ? "jackpot1" : "jackpot"]: jackpotAmount },
      sourceUrl: currentConfig.sourceUrl,
      source: "manual",
      importedAt: now,
      crawledAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const merged = mergeDraws(snapshot.draws, [manualDraw]);
    saveSnapshot({ ...snapshot, draws: merged.draws });
    setPublishedHistory([manualDraw, ...publishedHistory.filter((draw) => draw.drawDate !== manualDraw.drawDate)].slice(0, 6));
    setIsHistoryDialogOpen(false);
    setCrawlStatus("success");
    setStatusMessage(
      `Manual history saved for ${currentConfig.name} on ${formatDisplayDate(manualDraw.drawDate)}.`,
    );

    try {
      const response = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lotteryType: selectedLotteryType, records: [manualDraw] }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Mongo save failed ${response.status}`);
      setPublishedHistoryStatus("Manual row saved locally and synced to MongoDB.");
      await loadPublishedHistory(selectedLotteryType);
    } catch (error) {
      setPublishedHistoryStatus(
        error instanceof Error
          ? `Manual row saved locally. Mongo sync failed: ${error.message}`
          : "Manual row saved locally. Mongo sync failed.",
      );
    }
  }

  async function handleUpdateSelectedHistory() {
    if (!(selectedLotteryType in VIETLOTT_DATA_SOURCES)) {
      setCrawlStatus("error");
      setPublishedHistoryStatus(`${currentConfig.name} does not have an import source yet.`);
      return;
    }

    setCrawlStatus("running");
    setPublishedHistoryStatus(`Checking ${currentConfig.name} history against the latest crawl data...`);

    try {
      const response = await fetch(`/api/crawl?lotteryType=${selectedLotteryType}&latest=5`, {
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

      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `History update failed ${response.status}`);
      }

      const records = payload.records ?? [];
      const merged = mergeDraws(snapshot.draws, records);
      const latestMergedDraw = merged.draws
        .filter((draw) => draw.lotteryType === selectedLotteryType)
        .sort((a, b) => b.drawDate.localeCompare(a.drawDate))[0];

      saveSnapshot({ ...snapshot, draws: merged.draws });
      setCrawlStatus("success");
      setStatusMessage(
        `Latest 5 crawl rows checked for ${currentConfig.name}: +${merged.added} local, ${merged.updated} overwritten by draw date, ${payload.skipped ?? 0} unchanged${payload.latestDrawDate ? `, latest ${payload.latestDrawDate}` : ""}.`,
      );
      setPublishedHistoryStatus(
        `Compared ${records.length} latest crawled rows. Same-day differences were overwritten by crawl data.`,
      );
      setIsHistoryDialogOpen(false);

      await loadPublishedHistory(selectedLotteryType);

      if (latestMergedDraw) {
        await handleEvaluatePurchasedNumbers(latestMergedDraw);
      }
    } catch (error) {
      setCrawlStatus("error");
      setPublishedHistoryStatus(error instanceof Error ? error.message : "History update failed.");
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
  const selectedLotteryCards: LotteryType[] = ["power655", "mega645", "power535"];
  const bestPredictionCoverage = bestPrediction ? scoreCoverage(bestPrediction.numbers, selectedDraws, selectedLotteryType).coverageScore : 0;
  const navLabel: Record<DashboardNavKey, string> = {
    dashboard: "Dashboard",
    "lottery-select": "Lottery Select",
    purchased: "Purchased",
    analytics: "Analytics",
    settings: "Settings",
  };
  const lotteryCardLabel: Record<LotteryType, string> = {
    power655: "Mega 6/55",
    mega645: "Mega 6/45",
    power535: "Lotto 5/35",
    max3d: "Max 3D",
  };

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl grid-cols-1 gap-4 px-4 py-5 lg:grid-cols-[250px_1fr]">
        <aside className="h-fit rounded-2xl border border-white/10 bg-slate-900/80 p-3">
          <div className="px-2 py-3">
            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Predict Lottery</div>
            <div className="mt-1 text-lg font-semibold">{LOTTERY_CONFIG[selectedLotteryType].name}</div>
          </div>
          <nav className="mt-2 space-y-1">
            {dashboardNav.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setActiveNav(item)}
                className={`w-full rounded-xl px-3 py-2 text-left text-sm ${
                  activeNav === item ? "bg-cyan-400 text-slate-950" : "text-slate-200 hover:bg-white/5"
                }`}
              >
                {navLabel[item]}
              </button>
            ))}
          </nav>
        </aside>

        <section className="space-y-4">
          <header className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-xl font-semibold">{navLabel[activeNav]}</h1>
              <div className="text-sm text-slate-300">{statusMessage}</div>
            </div>
          </header>

          {activeNav === "dashboard" && (
            <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 text-slate-300">
              Dashboard content placeholder. You can design this section later.
            </article>
          )}

          {activeNav === "lottery-select" && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {selectedLotteryCards.map((type) => {
                  const config = LOTTERY_CONFIG[type];
                  const active = selectedLotteryType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setSelectedLotteryType(type)}
                      className={`rounded-2xl border p-4 text-left ${active ? "border-cyan-400/60 bg-cyan-400/10" : "border-white/10 bg-slate-900/70"}`}
                    >
                      <div className="font-semibold">{lotteryCardLabel[type]}</div>
                      <div className="mt-1 text-sm text-slate-400">{config.pickCount} picks | max {config.maxNumber}</div>
                    </button>
                  );
                })}
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                  <div className="text-sm text-slate-300">Current prediction</div>
                  <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/70 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Last prediction</div>
                    <div className="mt-2 text-2xl font-semibold">
                      {bestPrediction ? bestPrediction.numbers.join(" - ") : "No prediction"}
                    </div>
                    <div className="mt-3 text-5xl font-semibold text-cyan-300">
                      {bestPrediction ? `${round(bestPrediction.score * 100, 0)}%` : "0%"}
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Other predictions</div>
                    {latestPrediction?.predictedSets.slice(1, 6).length ? (
                      latestPrediction.predictedSets.slice(1, 6).map((item, index) => (
                        <div key={`${item.numbers.join("-")}-${index}`} className="flex items-center justify-between rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm">
                          <span>{item.numbers.join(" - ")}</span>
                          <span className="text-cyan-300">{round(item.score * 100, 0)}%</span>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-slate-400">
                        No extra predictions yet.
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" onClick={handleGeneratePrediction} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950">Generate recommendation</button>
                    <button type="button" onClick={() => handleCompareLatestPrediction()} className="rounded-xl border border-emerald-400/30 px-4 py-2 text-sm font-semibold text-emerald-100">Compare latest result</button>
                  </div>
                </article>

                <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                  <div className="grid gap-4 xl:grid-cols-2">
                    <div>
                      <div className="text-sm text-slate-300">History</div>
                      <div className="mt-2 space-y-2">
                        {selectedDraws.slice(0, 5).map((draw) => (
                          <div key={draw.drawId} className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-sm">
                            <div className="text-slate-400">{formatDisplayDate(draw.drawDate)}</div>
                            <div className="mt-1">{draw.numbers.join(" - ")}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-sm text-slate-300">Analytics insights</div>
                      <div className="mt-2 space-y-2">
                        {selectedPurchased.slice(0, 5).map((purchase) => {
                          const actualDraw =
                            selectedDraws.find((draw) => draw.drawDate === purchase.targetDrawDate) ??
                            latestDraw;
                          const result = evaluatePurchase(purchase, actualDraw);
                          const referencePrediction = latestPrediction?.predictedSets[0];
                          return (
                            <div key={purchase.id} className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-xs">
                              <div className="text-slate-400">{formatDisplayDate(purchase.targetDrawDate)}</div>
                              <div className="mt-1">Buy: {purchase.selectedNumbers.join(" - ")}</div>
                              <div className="mt-1 text-slate-300">
                                Last pred: {referencePrediction ? referencePrediction.numbers.join(" - ") : "N/A"}
                              </div>
                              <div className="mt-1 text-emerald-300">
                                Prize: {result.prizeAmount > 0 ? currencyFormatter.format(result.prizeAmount) : "0"}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-sm">Next draw: {nextDrawDate}</div>
                    <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-sm">Coverage: {round(bestPredictionCoverage * 100, 1)}%</div>
                  </div>
                  <div className="mt-3">
                    <button type="button" onClick={() => void handleImportFromGitHub()} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold">Update data from GitHub</button>
                  </div>
                </article>
              </div>
            </div>
          )}

          {activeNav === "purchased" && (
            <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
              <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-5">
                <h2 className="text-lg font-semibold">Purchased numbers</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-slate-300">Target draw date
                    <input type="date" value={purchaseDraft.targetDrawDate} onChange={(event) => setPurchaseDraft((current) => ({ ...current, targetDrawDate: event.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-white outline-none" />
                  </label>
                  <label className="text-sm text-slate-300">Ticket price
                    <input type="number" min={0} step={1000} value={purchaseDraft.ticketPrice} onChange={(event) => setPurchaseDraft((current) => ({ ...current, ticketPrice: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-white outline-none" />
                  </label>
                  <label className="sm:col-span-2 text-sm text-slate-300">Numbers bought
                    <textarea value={purchaseDraft.numbersText} onChange={(event) => setPurchaseDraft((current) => ({ ...current, numbersText: event.target.value }))} className="mt-2 min-h-24 w-full rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-white outline-none" />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void handleSavePurchase()} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950">Save purchased numbers</button>
                  <button type="button" onClick={() => void handleEvaluatePurchasedNumbers()} className="rounded-xl border border-emerald-400/30 px-4 py-2 text-sm font-semibold text-emerald-100">Evaluate with latest</button>
                </div>
                <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/70 p-3 text-sm text-slate-300">{purchaseStatus}</div>
              </article>
              <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Saved purchases</h3>
                  <button type="button" onClick={() => void refreshPurchased()} className="rounded-xl border border-white/10 px-3 py-2 text-sm">Refresh</button>
                </div>
                <div className="space-y-2">
                  {selectedPurchased.slice(0, 10).map((purchase) => (
                    <div key={purchase.id} className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-sm">
                      {formatDisplayDate(purchase.targetDrawDate)} | {purchase.selectedNumbers.join(" - ")}
                    </div>
                  ))}
                </div>
              </article>
            </section>
          )}

          {activeNav === "analytics" && (
            <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 text-slate-300">
              Analytics content placeholder. You can design this section later.
            </article>
          )}

          {activeNav === "settings" && (
            <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
              <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-5">
                <h2 className="text-lg font-semibold">Settings</h2>
                <div className="mt-4 space-y-3">
                  <button type="button" onClick={() => void handleImportFromGitHub()} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold">Update data from GitHub</button>
                  <button type="button" onClick={() => void handleTestMongoConnection()} disabled={mongoTestLoading} className="rounded-xl border border-cyan-400/30 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-60">{mongoTestLoading ? "Testing..." : "Test MongoDB Connection"}</button>
                  <button type="button" onClick={() => void handleLoadFromMongoSnapshot()} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold">Load snapshot</button>
                  <button type="button" onClick={() => void handleSyncMongoSnapshot()} className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950">Sync snapshot</button>
                </div>
              </article>
              <article className="rounded-2xl border border-white/10 bg-slate-900/70 p-5 text-sm">
                <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3">Mongo status: {mongoStatus}</div>
                <div className="mt-2 rounded-xl border border-white/10 bg-slate-950/70 p-3">Connection test: {mongoTestStatus}</div>
                <pre className="mt-2 max-h-64 overflow-auto rounded-xl border border-white/10 bg-slate-950/70 p-3 text-xs">{getMongoSchema()}</pre>
              </article>
            </section>
          )}

        </section>
      </div>
    </main>
  );
}
