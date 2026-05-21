import { isMongoConfigured, readPurchasedSets, upsertPurchasedSet } from "@/app/lib/mongodb";
import type { PurchasedSet } from "@/app/lib/types";

export async function GET(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const lotteryType = searchParams.get("lotteryType");
    const purchasedSets = await readPurchasedSets();
    const filtered = lotteryType ? purchasedSets.filter((item) => item.lotteryType === lotteryType) : purchasedSets;
    return Response.json({ purchasedSets: filtered });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể tải purchasedNumbers." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const body = (await request.json()) as { purchasedSet?: PurchasedSet };
    if (!body.purchasedSet) {
      return Response.json({ error: "Thiếu purchasedSet trong body." }, { status: 400 });
    }

    await upsertPurchasedSet(body.purchasedSet);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể lưu purchasedSet." },
      { status: 500 },
    );
  }
}
