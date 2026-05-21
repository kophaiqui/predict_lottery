import { isMongoConfigured, insertModelVersion, upsertGeneratedPrediction } from "@/app/lib/mongodb";
import type { PredictionRecord } from "@/app/lib/types";

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const body = (await request.json()) as { prediction?: PredictionRecord };
    if (!body.prediction) {
      return Response.json({ error: "Thiếu prediction trong body." }, { status: 400 });
    }

    await upsertGeneratedPrediction(body.prediction);
    if (body.prediction.modelVersion) {
      await insertModelVersion({
        ...body.prediction,
        modelVersion: body.prediction.modelVersion,
      });
    }

    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể lưu prediction." },
      { status: 500 },
    );
  }
}
