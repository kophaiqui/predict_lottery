import { isMongoConfigured, testMongoConnection } from "@/app/lib/mongodb";

export async function GET() {
  if (!isMongoConfigured()) {
    return Response.json({ ok: false, message: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const result = await testMongoConnection();
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { ok: false, message: error instanceof Error ? error.message : "Không thể test MongoDB." },
      { status: 500 },
    );
  }
}
