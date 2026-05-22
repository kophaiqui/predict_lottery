"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { LOTTERY_CONFIG } from "@/app/lib/lottery-config";
import { VIETLOTT_DATA_SOURCES } from "@/app/lib/vietlott-data-config";
import { runRollingBacktest } from "@/app/lib/backtesting-advanced";
import { buildMongoSummary, getMongoSchema } from "@/app/lib/mongodb-info";
import { summarizeQuality, validateCrawlBatch } from "@/app/lib/data-quality";
import { evaluatePrizeTier } from "@/app/lib/prize-rules";
import { comparePredictionToActual, generatePredictions, updatePerformance } from "@/app/lib/prediction-engine";
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
const dashboardNav = ["dashboard", "purchased", "analytics", "settings"] as const;
type DashboardNavKey = (typeof dashboardNav)[number];
const personalLotteryTypes: LotteryType[] = ["power655", "mega645", "power535"];

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

function formatModelScore(score: number) {
  return round(score, 2).toFixed(2);
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
  const [activeNav, setActiveNav] = useState<DashboardNavKey>("dashboard");
  const [selectedLotteryType, setSelectedLotteryType] = useState<LotteryType>("mega645");
  const [predictionCount] = useState(5);
  const [historyWindow] = useState(6);
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
  const [analysisFromDate] = useState("2025-01-01");
  const [analysisToDate] = useState(formatDate(new Date()));
  const [trainWindow] = useState(8);
  const [testWindow] = useState(6);
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
  const selectedPredictions = useMemo(
    () => snapshot.predictions.filter((prediction) => prediction.lotteryType === selectedLotteryType).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)),
    [snapshot.predictions, selectedLotteryType],
  );
  const selectedPurchased = useMemo(
    () => purchaseRecords.filter((purchase) => purchase.lotteryType === selectedLotteryType).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [purchaseRecords, selectedLotteryType],
  );
  const personalPurchases = useMemo(
    () =>
      purchaseRecords
        .filter((purchase) => personalLotteryTypes.includes(purchase.lotteryType))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [purchaseRecords],
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
  const totalSpent = personalPurchases.reduce((total, purchase) => total + purchase.totalCost, 0);
  const evaluatedPurchases = personalPurchases.map((purchase) => {
    const actualDraw = snapshot.draws.find(
      (draw) => draw.lotteryType === purchase.lotteryType && draw.drawDate === purchase.targetDrawDate,
    );
    return {
      purchase,
      actualDraw,
      result: evaluatePurchase(purchase, actualDraw),
    };
  });
  const totalPrize = evaluatedPurchases.reduce((total, item) => total + item.result.prizeAmount, 0);

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

  async function handleUpdateHistoryForLottery(lotteryType: LotteryType) {
    if (!(lotteryType in VIETLOTT_DATA_SOURCES)) {
      setCrawlStatus("error");
      setPublishedHistoryStatus(`${LOTTERY_CONFIG[lotteryType].name} does not have an import source yet.`);
      return;
    }

    setSelectedLotteryType(lotteryType);
    setCrawlStatus("running");
    setPublishedHistoryStatus(`Checking ${LOTTERY_CONFIG[lotteryType].name} history against the latest crawl data...`);

    try {
      const response = await fetch(`/api/crawl?lotteryType=${lotteryType}&latest=5`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
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
        .filter((draw) => draw.lotteryType === lotteryType)
        .sort((a, b) => b.drawDate.localeCompare(a.drawDate))[0];

      saveSnapshot({ ...snapshot, draws: merged.draws });
      setCrawlStatus("success");
      setStatusMessage(
        `Latest 5 crawl rows checked for ${LOTTERY_CONFIG[lotteryType].name}: +${merged.added} local, ${merged.updated} overwritten by draw date, ${payload.skipped ?? 0} unchanged${payload.latestDrawDate ? `, latest ${payload.latestDrawDate}` : ""}.`,
      );
      setPublishedHistoryStatus(
        `Compared ${records.length} latest crawled rows. Same-day differences were overwritten by crawl data.`,
      );

      await loadPublishedHistory(lotteryType);

      if (latestMergedDraw) {
        await handleEvaluatePurchasedNumbers(latestMergedDraw);
      }
    } catch (error) {
      setCrawlStatus("error");
      setPublishedHistoryStatus(error instanceof Error ? error.message : "History update failed.");
    }
  }

  async function handleUpdateAllPersonalHistory() {
    setCrawlStatus("running");
    setPublishedHistoryStatus("Checking latest history for your three lotteries...");

    try {
      let nextSnapshot = snapshot;
      const summaries: string[] = [];

      for (const lotteryType of personalLotteryTypes) {
        const response = await fetch(`/api/crawl?lotteryType=${lotteryType}&latest=5`, {
          method: "POST",
        });
        const payload = (await response.json()) as {
          ok?: boolean;
          skipped?: number;
          latestDrawDate?: string | null;
          records?: DrawRecord[];
          error?: string;
        };

        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error ?? `History update failed ${response.status}`);
        }

        const merged = mergeDraws(nextSnapshot.draws, payload.records ?? []);
        nextSnapshot = { ...nextSnapshot, draws: merged.draws };
        summaries.push(
          `${LOTTERY_CONFIG[lotteryType].name}: +${merged.added}, ${merged.updated} updated, ${payload.skipped ?? 0} same${payload.latestDrawDate ? `, latest ${payload.latestDrawDate}` : ""}`,
        );
      }

      saveSnapshot(nextSnapshot);
      setCrawlStatus("success");
      setStatusMessage(`History updated. ${summaries.join(" | ")}`);
      setPublishedHistoryStatus("All three lottery histories are current from the latest crawl rows.");
      await loadPublishedHistory(selectedLotteryType);
    } catch (error) {
      setCrawlStatus("error");
      setPublishedHistoryStatus(error instanceof Error ? error.message : "History update failed.");
    }
  }

  function handleGeneratePredictionForLottery(lotteryType: LotteryType) {
    const draws = snapshot.draws
      .filter((draw) => draw.lotteryType === lotteryType)
      .sort((a, b) => a.drawDate.localeCompare(b.drawDate));
    const history = draws.slice(Math.max(0, draws.length - historyWindow));
    const targetDrawDate = buildTargetDate(draws, lotteryType);
    const prediction = generatePredictions({
      lotteryType,
      history,
      count: predictionCount,
      performance: snapshot.performance,
      targetDrawDate,
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
    setSelectedLotteryType(lotteryType);
    setPurchaseDraft((current) => ({
      ...current,
      targetDrawDate: prediction.targetDrawDate,
      predictionId: prediction.id,
      numbersText: prediction.predictedSets[0]?.numbers.join(" ") ?? current.numbersText,
    }));
  }

  function handleGeneratePrediction() {
    handleGeneratePredictionForLottery(selectedLotteryType);
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
    setActiveNav("purchased");
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
      setActiveNav("purchased");
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

  const bestPrediction = latestPrediction?.predictedSets[0];
  const bestPredictionCoverage = bestPrediction ? scoreCoverage(bestPrediction.numbers, selectedDraws, selectedLotteryType).coverageScore : 0;
  const navLabel: Record<DashboardNavKey, string> = {
    dashboard: "Today",
    purchased: "Purchased",
    analytics: "Insights",
    settings: "Settings",
  };
  const lotteryCardLabel: Record<LotteryType, string> = {
    power655: "Power 6/55",
    mega645: "Mega 6/45",
    power535: "Power 5/35",
    max3d: "Max 3D",
  };
  const qualitySummary = summarizeQuality(qualityReport);

  return (
    <main className="min-h-screen bg-[#151718] text-[#f4f4f5]">
      <div className="mx-auto grid min-h-screen w-full max-w-none grid-cols-1 gap-4 px-4 py-5 lg:grid-cols-[minmax(180px,15%)_minmax(0,85%)]">
        <aside className="h-fit min-w-0 rounded-lg border border-[#33383b] bg-[#1d2022] p-3 shadow-sm">
          <div className="px-2 py-3">
            <div className="text-xs uppercase text-[#a1a1aa]">Predict Lottery</div>
            <div className="mt-1 text-lg font-semibold">{LOTTERY_CONFIG[selectedLotteryType].name}</div>
          </div>
          <nav className="mt-2 space-y-1">
            {dashboardNav.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setActiveNav(item)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium transition ${
                  activeNav === item ? "bg-[#4ade80] text-[#052e16]" : "text-[#d4d4d8] hover:bg-[#272b2e]"
                }`}
              >
                {navLabel[item]}
              </button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 space-y-4">
          <header className="rounded-lg border border-[#33383b] bg-[#1d2022] p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold">{navLabel[activeNav]}</h1>
                <div className="mt-1 text-sm text-[#a1a1aa]">{selectedDraws.length} draws tracked for {currentConfig.name}</div>
              </div>
              <div className={`rounded-md border px-3 py-2 text-sm ${
                crawlStatus === "error"
                  ? "border-red-500/40 bg-red-500/10 text-red-200"
                  : crawlStatus === "success"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : crawlStatus === "running"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                      : "border-[#33383b] bg-[#1d2022] text-[#d4d4d8]"
              }`}>{statusMessage}</div>
            </div>
          </header>

          {activeNav === "dashboard" && (
            <div className="space-y-4">
              <section className="grid min-w-0 gap-3 xl:grid-cols-3">
                {personalLotteryTypes.map((type) => {
                  const config = LOTTERY_CONFIG[type];
                  const active = selectedLotteryType === type;
                  const draws = snapshot.draws
                    .filter((draw) => draw.lotteryType === type)
                    .sort((a, b) => b.drawDate.localeCompare(a.drawDate));
                  const predictions = snapshot.predictions
                    .filter((prediction) => prediction.lotteryType === type)
                    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
                  const cardLatestDraw = draws[0];
                  const cardPrediction = predictions[0];
                  const cardBest = cardPrediction?.predictedSets[0];
                  const cardNextDrawDate = buildTargetDate(draws, type);
                  return (
                    <article
                      key={type}
                      className={`min-w-0 rounded-lg border bg-[#1d2022] p-4 shadow-sm ${active ? "border-[#4ade80]" : "border-[#33383b]"}`}
                    >
                      <button type="button" onClick={() => setSelectedLotteryType(type)} className="w-full text-left">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-lg font-semibold">{lotteryCardLabel[type]}</div>
                            <div className="text-sm text-[#a1a1aa]">{config.pickCount} picks, max {config.maxNumber}</div>
                          </div>
                          <span className="shrink-0 rounded-md bg-[#193326] px-2 py-1 text-xs font-semibold text-[#bbf7d0]">
                            {formatDisplayDate(cardNextDrawDate)}
                          </span>
                        </div>
                        <div className="mt-4 text-sm text-[#a1a1aa]">Best prediction</div>
                        <div className="mt-2 flex min-w-0 flex-wrap gap-2">
                          {cardBest ? (
                            cardBest.numbers.map((number) => (
                              <span key={number} className="grid h-9 w-9 place-items-center rounded-full bg-[#4ade80] text-sm font-semibold text-[#052e16]">
                                {number}
                              </span>
                            ))
                          ) : (
                            <span className="text-sm text-[#a1a1aa]">No prediction yet</span>
                          )}
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                          <div className="rounded-md bg-[#151718] p-2">
                            <div className="text-[#a1a1aa]">Model score</div>
                            <div className="font-semibold">{cardBest ? formatModelScore(cardBest.score) : "N/A"}</div>
                          </div>
                          <div className="rounded-md bg-[#151718] p-2">
                            <div className="text-[#a1a1aa]">Last draw</div>
                            <div className="font-semibold">{cardLatestDraw ? formatDisplayDate(cardLatestDraw.drawDate) : "N/A"}</div>
                          </div>
                        </div>
                      </button>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => handleGeneratePredictionForLottery(type)} className="rounded-md bg-[#4ade80] px-3 py-2 text-sm font-semibold text-[#052e16]">Predict</button>
                        <button type="button" onClick={() => void handleUpdateHistoryForLottery(type)} className="rounded-md border border-[#33383b] px-3 py-2 text-sm font-semibold text-[#d4d4d8]">Update</button>
                      </div>
                    </article>
                  );
                })}
              </section>

              <section className="grid min-w-0 gap-4 lg:grid-cols-[1.05fr_0.95fr]">
                <article className="min-w-0 rounded-lg border border-[#33383b] bg-[#1d2022] p-4 shadow-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold">{currentConfig.name}</h2>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => void handleUpdateAllPersonalHistory()} className="rounded-md border border-[#33383b] px-3 py-2 text-sm font-semibold">Update all</button>
                      <button type="button" onClick={() => void handleUpdateSelectedHistory()} className="rounded-md border border-[#33383b] px-3 py-2 text-sm font-semibold">Update history</button>
                      <button type="button" onClick={openHistoryDialog} className="rounded-md bg-[#f97316] px-3 py-2 text-sm font-semibold text-[#052e16]">Add draw</button>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <div className="rounded-md bg-[#151718] p-3">
                      <div className="text-sm text-[#a1a1aa]">Next draw</div>
                      <div className="font-semibold">{formatDisplayDate(nextDrawDate)}</div>
                    </div>
                    <div className="rounded-md bg-[#151718] p-3">
                      <div className="text-sm text-[#a1a1aa]">Coverage</div>
                      <div className="font-semibold">{round(bestPredictionCoverage * 100, 1)}%</div>
                    </div>
                    <div className="rounded-md bg-[#151718] p-3">
                      <div className="text-sm text-[#a1a1aa]">Latest prize</div>
                      <div className="font-semibold">{formatJackpot(latestDraw)}</div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="font-semibold">Recent history</h3>
                      <span className="text-sm text-[#a1a1aa]">{publishedHistoryStatus}</span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {(publishedHistory.length ? publishedHistory : selectedDraws).slice(0, 6).map((draw) => (
                        <div key={draw.drawId} className="rounded-md border border-[#33383b] bg-[#1d2022] p-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">{formatDisplayDate(draw.drawDate)}</span>
                            <span className="text-[#a1a1aa]">{draw.source ?? "local"}</span>
                          </div>
                          <div className="mt-2 font-mono">{draw.numbers.join(" - ")}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {isHistoryDialogOpen && (
                    <div className="mt-4 rounded-lg border border-[#33383b] bg-[#1d2022] p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <h3 className="font-semibold">Add draw for {currentConfig.name}</h3>
                        <button type="button" onClick={() => setIsHistoryDialogOpen(false)} className="rounded-md border border-[#33383b] px-2 py-1 text-sm">Close</button>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="text-sm text-[#d4d4d8]">Draw date
                          <input type="date" value={historyDraft.drawDate} onChange={(event) => setHistoryDraft((current) => ({ ...current, drawDate: event.target.value }))} className="mt-1 w-full rounded-md border border-[#33383b] bg-[#111315] px-3 py-2 text-[#f4f4f5] outline-none" />
                        </label>
                        <label className="text-sm text-[#d4d4d8]">Jackpot / prize
                          <input value={historyDraft.jackpotText} onChange={(event) => setHistoryDraft((current) => ({ ...current, jackpotText: event.target.value }))} placeholder="12000000000" className="mt-1 w-full rounded-md border border-[#33383b] bg-[#111315] px-3 py-2 text-[#f4f4f5] outline-none" />
                        </label>
                        <label className="text-sm text-[#d4d4d8] sm:col-span-2">Numbers
                          <textarea value={historyDraft.numbersText} onChange={(event) => setHistoryDraft((current) => ({ ...current, numbersText: event.target.value }))} className="mt-1 min-h-20 w-full rounded-md border border-[#33383b] bg-[#111315] px-3 py-2 text-[#f4f4f5] outline-none" />
                        </label>
                        {currentConfig.hasBonus && (
                          <label className="text-sm text-[#d4d4d8]">Special number
                            <input value={historyDraft.bonusText} onChange={(event) => setHistoryDraft((current) => ({ ...current, bonusText: event.target.value }))} className="mt-1 w-full rounded-md border border-[#33383b] bg-[#111315] px-3 py-2 text-[#f4f4f5] outline-none" />
                          </label>
                        )}
                      </div>
                      <button type="button" onClick={() => void handleSaveManualHistory()} className="mt-3 rounded-md bg-[#4ade80] px-4 py-2 text-sm font-semibold text-[#052e16]">Save draw</button>
                    </div>
                  )}
                </article>

                <article className="min-w-0 rounded-lg border border-[#33383b] bg-[#1d2022] p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold">Prediction stack</h2>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => handleCompareLatestPrediction()} className="rounded-md border border-[#33383b] px-3 py-2 text-sm font-semibold">Compare</button>
                      <button type="button" onClick={handleGeneratePrediction} className="rounded-md bg-[#4ade80] px-3 py-2 text-sm font-semibold text-[#052e16]">Generate</button>
                    </div>
                  </div>
                  <div className="mt-4 rounded-md bg-[#4ade80] p-4 text-[#052e16]">
                    <div className="text-sm text-[#052e16]">Primary set</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {bestPrediction ? bestPrediction.numbers.map((number) => (
                        <span key={number} className="grid h-10 w-10 place-items-center rounded-full bg-[#f4f4f5] text-sm font-semibold text-[#14532d]">{number}</span>
                      )) : <span>No prediction yet</span>}
                    </div>
                    <div className="mt-3 text-sm text-[#052e16]">
                      {bestPrediction ? `Model score ${formatModelScore(bestPrediction.score)}. This is not win probability.` : "Generate a set to start."}
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {latestPrediction?.predictedSets.slice(1, 5).map((item, index) => (
                      <button key={`${item.numbers.join("-")}-${index}`} type="button" onClick={() => handleUsePrediction(item)} className="flex w-full items-center justify-between gap-3 rounded-md border border-[#33383b] bg-[#1d2022] px-3 py-2 text-left text-sm">
                        <span className="font-mono">{item.numbers.join(" - ")}</span>
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${confidenceClass(item.score)}`}>
                          {formatModelScore(item.score)}
                        </span>
                      </button>
                    ))}
                    {!latestPrediction?.predictedSets.slice(1, 5).length && (
                      <div className="rounded-md border border-[#33383b] bg-[#1d2022] px-3 py-2 text-sm text-[#a1a1aa]">No extra sets yet.</div>
                    )}
                  </div>
                </article>
              </section>
            </div>
          )}

          {activeNav === "purchased" && (
            <section className="grid min-w-0 gap-4 lg:grid-cols-[0.8fr_1.2fr]">
              <article className="min-w-0 rounded-lg border border-[#33383b] bg-[#1d2022] p-5 shadow-sm">
                <h2 className="text-lg font-semibold">Purchased numbers</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-[#d4d4d8]">Target draw date
                    <input type="date" value={purchaseDraft.targetDrawDate} onChange={(event) => setPurchaseDraft((current) => ({ ...current, targetDrawDate: event.target.value }))} className="mt-2 w-full rounded-md border border-[#33383b] bg-[#111315] px-3 py-2 text-[#f4f4f5] outline-none" />
                  </label>
                  <label className="text-sm text-[#d4d4d8]">Ticket price
                    <input type="number" min={0} step={1000} value={purchaseDraft.ticketPrice} onChange={(event) => setPurchaseDraft((current) => ({ ...current, ticketPrice: Number(event.target.value) }))} className="mt-2 w-full rounded-md border border-[#33383b] bg-[#111315] px-3 py-2 text-[#f4f4f5] outline-none" />
                  </label>
                  <label className="sm:col-span-2 text-sm text-[#d4d4d8]">Numbers bought
                    <textarea value={purchaseDraft.numbersText} onChange={(event) => setPurchaseDraft((current) => ({ ...current, numbersText: event.target.value }))} className="mt-2 min-h-24 w-full rounded-md border border-[#33383b] bg-[#111315] px-3 py-2 text-[#f4f4f5] outline-none" />
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void handleSavePurchase()} className="rounded-md bg-[#4ade80] px-4 py-2 text-sm font-semibold text-[#052e16]">Save purchase</button>
                  <button type="button" onClick={() => void handleEvaluatePurchasedNumbers()} className="rounded-md border border-[#33383b] px-4 py-2 text-sm font-semibold">Evaluate latest</button>
                </div>
                <div className="mt-3 rounded-md border border-[#33383b] bg-[#1d2022] p-3 text-sm text-[#d4d4d8]">{purchaseStatus}</div>
              </article>
              <article className="min-w-0 rounded-lg border border-[#33383b] bg-[#1d2022] p-5 shadow-sm">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Purchase comparison</h3>
                  <button type="button" onClick={() => void refreshPurchased()} className="rounded-md border border-[#33383b] px-3 py-2 text-sm">Refresh</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="border-b border-[#33383b] text-[#a1a1aa]">
                      <tr>
                        <th className="py-2 pr-3 font-medium">Date</th>
                        <th className="py-2 pr-3 font-medium">Lottery</th>
                        <th className="py-2 pr-3 font-medium">Purchased</th>
                        <th className="py-2 pr-3 font-medium">Prediction</th>
                        <th className="py-2 pr-3 font-medium">Prize result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {personalPurchases.slice(0, 12).map((purchase) => {
                        const prediction = snapshot.predictions.find((item) => item.id === purchase.predictionId)
                          ?? snapshot.predictions.find((item) => item.lotteryType === purchase.lotteryType && item.targetDrawDate === purchase.targetDrawDate);
                        const predictedNumbers = prediction?.predictedSets[0]?.numbers ?? [];
                        const actualDraw = snapshot.draws.find((draw) => draw.lotteryType === purchase.lotteryType && draw.drawDate === purchase.targetDrawDate);
                        const result = evaluatePurchase(purchase, actualDraw);
                        const predictionHits = actualDraw ? predictedNumbers.filter((number) => actualDraw.numbers.includes(number)).length : 0;
                        return (
                          <tr key={purchase.id} className="border-b border-[#272b2e]">
                            <td className="py-3 pr-3">{formatDisplayDate(purchase.targetDrawDate)}</td>
                            <td className="py-3 pr-3">{lotteryCardLabel[purchase.lotteryType]}</td>
                            <td className="py-3 pr-3 font-mono">{purchase.selectedNumbers.join(" - ")}</td>
                            <td className="py-3 pr-3 font-mono">{predictedNumbers.length ? `${predictedNumbers.join(" - ")} (${predictionHits} hit)` : "N/A"}</td>
                            <td className="py-3 pr-3">
                              {actualDraw ? `${result.matchCount} hit, ${result.prizeAmount ? currencyFormatter.format(result.prizeAmount) : "0"}` : "Waiting result"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!personalPurchases.length && (
                    <div className="rounded-md border border-[#33383b] bg-[#1d2022] p-3 text-sm text-[#a1a1aa]">No purchase history yet.</div>
                  )}
                </div>
              </article>
            </section>
          )}

          {activeNav === "analytics" && (
            <section className="min-w-0 space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-[#33383b] bg-[#1d2022] p-4 shadow-sm">
                  <div className="text-sm text-[#a1a1aa]">Spent</div>
                  <div className="mt-1 text-xl font-semibold">{currencyFormatter.format(totalSpent)}</div>
                </div>
                <div className="rounded-lg border border-[#33383b] bg-[#1d2022] p-4 shadow-sm">
                  <div className="text-sm text-[#a1a1aa]">Estimated prize</div>
                  <div className="mt-1 text-xl font-semibold">{currencyFormatter.format(totalPrize)}</div>
                </div>
                <div className="rounded-lg border border-[#33383b] bg-[#1d2022] p-4 shadow-sm">
                  <div className="text-sm text-[#a1a1aa]">Winning purchases</div>
                  <div className="mt-1 text-xl font-semibold">{numberFormatter.format(winningPurchases)}</div>
                </div>
                <div className="rounded-lg border border-[#33383b] bg-[#1d2022] p-4 shadow-sm">
                  <div className="text-sm text-[#a1a1aa]">Model edge</div>
                  <div className="mt-1 text-xl font-semibold">{rollingBacktest ? round(rollingBacktest.edge, 2) : "N/A"}</div>
                </div>
              </div>
              <article className="rounded-lg border border-[#33383b] bg-[#1d2022] p-5 shadow-sm">
                <h2 className="text-lg font-semibold">Selected lottery insight</h2>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <div className="rounded-md bg-[#151718] p-3">
                    <div className="text-sm text-[#a1a1aa]">Hot numbers</div>
                    <div className="mt-1 font-mono">{trendStats.hotNumbers.map((item) => item.number).join(" - ")}</div>
                  </div>
                  <div className="rounded-md bg-[#151718] p-3">
                    <div className="text-sm text-[#a1a1aa]">Cold numbers</div>
                    <div className="mt-1 font-mono">{trendStats.coldNumbers.map((item) => item.number).join(" - ")}</div>
                  </div>
                  <div className="rounded-md bg-[#151718] p-3">
                    <div className="text-sm text-[#a1a1aa]">Data quality</div>
                    <div className="mt-1 font-semibold">{qualitySummary}</div>
                  </div>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-md border border-[#33383b] bg-[#1d2022] p-3 text-sm">
                    <div className="font-semibold">Coverage note</div>
                    <div className="mt-1 text-[#d4d4d8]">{predictionCoverageSummary} Current score: {round(predictionCoverage * 100, 1)}%.</div>
                  </div>
                  <div className="rounded-md border border-[#33383b] bg-[#1d2022] p-3 text-sm">
                    <div className="font-semibold">Best model signals</div>
                    <div className="mt-1 text-[#d4d4d8]">
                      {patternPerformance.slice(0, 3).map(([name, stat]) => `${name} ${round(stat.edge, 2)}`).join(" | ") || "No pattern results yet"}
                    </div>
                  </div>
                </div>
              </article>
            </section>
          )}

          {activeNav === "settings" && (
            <section className="grid min-w-0 gap-4 lg:grid-cols-[1fr_1fr]">
              <article className="min-w-0 rounded-lg border border-[#33383b] bg-[#1d2022] p-5 shadow-sm">
                <h2 className="text-lg font-semibold">Settings</h2>
                <div className="mt-4 space-y-3">
                  <button type="button" onClick={() => void handleImportFromGitHub()} className="rounded-md border border-[#33383b] px-4 py-2 text-sm font-semibold">Update data from GitHub</button>
                  <button type="button" onClick={() => void handleTestMongoConnection()} disabled={mongoTestLoading} className="rounded-md border border-[#4ade80]/30 px-4 py-2 text-sm font-semibold text-[#4ade80] disabled:opacity-60">{mongoTestLoading ? "Testing..." : "Test MongoDB Connection"}</button>
                  <button type="button" onClick={() => void handleLoadFromMongoSnapshot()} className="rounded-md border border-[#33383b] px-4 py-2 text-sm font-semibold">Load snapshot</button>
                  <button type="button" onClick={() => void handleSaveAnalytics()} className="rounded-md border border-[#33383b] px-4 py-2 text-sm font-semibold">Save analytics</button>
                  <button type="button" onClick={() => void handleSyncMongoSnapshot()} className="rounded-md bg-[#4ade80] px-4 py-2 text-sm font-semibold text-[#052e16]">Sync snapshot</button>
                </div>
              </article>
              <article className="min-w-0 rounded-lg border border-[#33383b] bg-[#1d2022] p-5 text-sm shadow-sm">
                <div className="rounded-md border border-[#33383b] bg-[#1d2022] p-3">Mongo status: {mongoStatus}</div>
                <div className="mt-2 rounded-md border border-[#33383b] bg-[#1d2022] p-3">Connection test: {mongoTestStatus}</div>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-[#33383b] bg-[#1d2022] p-3 text-xs">{getMongoSchema()}</pre>
              </article>
            </section>
          )}

        </section>
      </div>
    </main>
  );
}
