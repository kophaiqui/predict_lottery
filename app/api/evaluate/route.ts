import { comparePredictionToActual } from "@/app/lib/prediction-engine";
import { evaluatePrizeTier } from "@/app/lib/prize-rules";
import {
  isMongoConfigured,
  insertBacktestResult,
  insertCrawlLog,
  insertModelVersion,
  upsertEvaluation,
  upsertModelPerformance,
} from "@/app/lib/mongodb";
import type {
  CrawlQualityReport,
  DashboardSnapshot,
  DrawRecord,
  ModelVersionSnapshot,
  PredictionRecord,
  PurchasedSet,
  RollingBacktestResult,
} from "@/app/lib/types";

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const body = (await request.json()) as {
      prediction?: PredictionRecord;
      actualDraw?: DrawRecord;
      purchasedSet?: PurchasedSet;
      backtest?: RollingBacktestResult;
      quality?: CrawlQualityReport;
      modelVersion?: ModelVersionSnapshot;
      snapshot?: DashboardSnapshot;
    };

    if (body.backtest) {
      await insertBacktestResult({
        ...body.backtest,
        lotteryType: body.backtest.params.lotteryType,
        createdAt: new Date().toISOString(),
      });
    }

    if (body.quality) {
      await insertCrawlLog({
        ...body.quality,
        lotteryType: body.prediction?.lotteryType ?? body.backtest?.params.lotteryType ?? "mega645",
        sourceUrl: undefined,
      });
    }

    if (body.modelVersion) {
      await insertModelVersion(body.modelVersion);
    }

    if (body.prediction && body.actualDraw) {
      const evaluated = comparePredictionToActual(body.prediction, body.actualDraw.numbers);
      const best = evaluated.predictedSets[0];
      const prize = evaluatePrizeTier({
        lotteryType: body.prediction.lotteryType,
        predictedNumbers: best?.numbers ?? [],
        actualDraw: body.actualDraw,
      });

      await upsertEvaluation({
        id: `${body.prediction.lotteryType}-${body.actualDraw.drawId}`,
        lotteryType: body.prediction.lotteryType,
        drawId: body.actualDraw.drawId,
        predictionId: body.prediction.id,
        actualNumbers: body.actualDraw.numbers,
        predictedNumbers: best?.numbers ?? [],
        matchCount: best?.hits ?? 0,
        prizeAmount: prize.prizeAmount,
        createdAt: new Date().toISOString(),
      });
    }

    if (body.purchasedSet && body.actualDraw) {
      const matchCount = body.purchasedSet.selectedNumbers.filter((number) => body.actualDraw?.numbers.includes(number)).length;
      const prize = evaluatePrizeTier({
        lotteryType: body.purchasedSet.lotteryType,
        predictedNumbers: body.purchasedSet.selectedNumbers,
        actualDraw: body.actualDraw,
      });

      await upsertEvaluation({
        id: `${body.purchasedSet.id}-${body.actualDraw.drawId}`,
        lotteryType: body.purchasedSet.lotteryType,
        drawId: body.actualDraw.drawId,
        predictionId: body.purchasedSet.predictionId,
        purchasedSetId: body.purchasedSet.id,
        actualNumbers: body.actualDraw.numbers,
        predictedNumbers: body.purchasedSet.selectedNumbers,
        matchCount,
        prizeAmount: prize.prizeAmount,
        createdAt: new Date().toISOString(),
      });
    }

    if (body.snapshot) {
      await upsertModelPerformance(body.snapshot.performance);
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể lưu evaluation." },
      { status: 500 },
    );
  }
}
