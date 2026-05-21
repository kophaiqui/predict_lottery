import { validateCrawlBatch } from "@/app/lib/data-quality";
import { insertCrawlLog, isMongoConfigured, readActualDraws, upsertActualDraws } from "@/app/lib/mongodb";
import { LOTTERY_CONFIG, LOTTERY_TYPES } from "@/app/lib/lottery-config";
import type { DrawRecord, LotteryType } from "@/app/lib/types";
import { importVietlottData } from "@/app/lib/vietlott-data";
import { VIETLOTT_DATA_SOURCES, type VietlottDataLotteryType } from "@/app/lib/vietlott-data-config";

type CrawlRequestBody = {
  lotteryType?: LotteryType;
  records?: DrawRecord[];
  replace?: boolean;
};

async function readRequestBody(request: Request): Promise<CrawlRequestBody> {
  const text = await request.text();
  if (!text.trim()) return {};

  return JSON.parse(text) as CrawlRequestBody;
}

function isLotteryType(value: string | null | undefined): value is LotteryType {
  return Boolean(value && LOTTERY_TYPES.includes(value as LotteryType));
}

export async function GET(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const lotteryType = searchParams.get("lotteryType");

  if (!isLotteryType(lotteryType)) {
    return Response.json({ error: "Missing or invalid lotteryType parameter." }, { status: 400 });
  }

  try {
    const records = await readActualDraws(lotteryType);
    return Response.json({
      lotteryType,
      records,
      count: records.length,
      source: "mongodb:actualDraws",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể đọc dữ liệu actualDraws." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const body = await readRequestBody(request);
    const requestedLotteryType = searchParams.get("lotteryType") ?? body.lotteryType;
    const replaceExisting = searchParams.get("replace") === "true" || body.replace === true;
    const latestCount = Number(searchParams.get("latest") ?? 0);

    if (
      isLotteryType(requestedLotteryType) &&
      requestedLotteryType in VIETLOTT_DATA_SOURCES &&
      !body.records?.length
    ) {
      const result = await importVietlottData(requestedLotteryType as VietlottDataLotteryType, {
        replaceExisting,
        latestCount: Number.isFinite(latestCount) && latestCount > 0 ? Math.trunc(latestCount) : undefined,
      });
      return Response.json({ ok: true, source: "github:vietvudanh/vietlott-data", ...result });
    }

    const records = body.records?.length ? body.records : null;

    if (!records) {
      return Response.json(
        { error: "Thiếu records trong body hoặc lotteryType hợp lệ trong nguồn GitHub." },
        { status: 400 },
      );
    }

    const lotteryType = isLotteryType(requestedLotteryType)
      ? requestedLotteryType
      : records[0]?.lotteryType;
    if (!isLotteryType(lotteryType)) {
      return Response.json({ error: "Missing or invalid lotteryType parameter." }, { status: 400 });
    }

    const existingDraws = await readActualDraws(lotteryType);
    const report = validateCrawlBatch({
      lotteryType,
      records,
      config: LOTTERY_CONFIG[lotteryType],
      existingDraws,
    });

    await insertCrawlLog({
      ...report,
      lotteryType,
      sourceUrl: LOTTERY_CONFIG[lotteryType].sourceUrl,
    });

    if (!report.accepted) {
      return Response.json({ ok: false, report, records }, { status: 422 });
    }

    const result = await upsertActualDraws(records);
    return Response.json({
      ok: true,
      lotteryType,
      report,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      records,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể lưu actualDraws." },
      { status: 500 },
    );
  }
}
