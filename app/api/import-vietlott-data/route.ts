import { isMongoConfigured } from "@/app/lib/mongodb";
import { importVietlottData } from "@/app/lib/vietlott-data";
import { VIETLOTT_DATA_SOURCES, type VietlottDataLotteryType } from "@/app/lib/vietlott-data-config";

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const lotteryType = searchParams.get("lotteryType") as VietlottDataLotteryType | null;
  const replaceExisting = searchParams.get("replace") === "true";

  if (!lotteryType || !(lotteryType in VIETLOTT_DATA_SOURCES)) {
    return Response.json({ error: "Missing or invalid lotteryType parameter." }, { status: 400 });
  }

  try {
    const result = await importVietlottData(lotteryType, { replaceExisting });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể import dữ liệu từ GitHub." },
      { status: 500 },
    );
  }
}
