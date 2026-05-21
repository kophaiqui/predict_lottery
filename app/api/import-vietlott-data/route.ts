import { isMongoConfigured } from "@/app/lib/mongodb";
import { importVietlottData } from "@/app/lib/vietlott-data";
import { VIETLOTT_DATA_SOURCES, type VietlottDataLotteryType } from "@/app/lib/vietlott-data-config";

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chua duoc cau hinh." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const lotteryType = searchParams.get("lotteryType") as VietlottDataLotteryType | null;

  if (!lotteryType || !(lotteryType in VIETLOTT_DATA_SOURCES)) {
    return Response.json({ error: "Missing or invalid lotteryType parameter." }, { status: 400 });
  }

  try {
    const result = await importVietlottData(lotteryType);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Khong the import du lieu tu GitHub." },
      { status: 500 },
    );
  }
}
