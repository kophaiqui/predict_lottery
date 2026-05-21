import { isMongoConfigured, readActualDraws, upsertActualDraws } from "@/app/lib/mongodb";
import { LOTTERY_TYPES } from "@/app/lib/lottery-config";
import type { DrawRecord } from "@/app/lib/types";

export async function GET(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chua duoc cau hinh." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const lotteryType = searchParams.get("lotteryType");

  if (!lotteryType || !LOTTERY_TYPES.includes(lotteryType as (typeof LOTTERY_TYPES)[number])) {
    return Response.json({ error: "Missing or invalid lotteryType parameter." }, { status: 400 });
  }

  try {
    const records = await readActualDraws(lotteryType as DrawRecord["lotteryType"]);
    return Response.json({
      lotteryType,
      records,
      count: records.length,
      source: "mongodb:actualDraws",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Khong the doc du lieu actualDraws." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chua duoc cau hinh." }, { status: 400 });
  }

  try {
    const body = (await request.json()) as { records?: DrawRecord[] };
    const records = body.records ?? null;

    if (!records) {
      return Response.json({ error: "Thieu records trong body." }, { status: 400 });
    }

    const result = await upsertActualDraws(records);
    return Response.json({
      ok: true,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Khong the luu actualDraws." },
      { status: 500 },
    );
  }
}
