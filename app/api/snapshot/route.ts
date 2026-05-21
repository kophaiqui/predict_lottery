import { isMongoConfigured, readMongoSnapshot, writeMongoSnapshot } from "@/app/lib/mongodb";
import type { DashboardSnapshot } from "@/app/lib/types";

export async function GET() {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const snapshot = await readMongoSnapshot();
    return Response.json({ snapshot });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể tải snapshot từ MongoDB." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!isMongoConfigured()) {
    return Response.json({ error: "MONGODB_URI chưa được cấu hình." }, { status: 400 });
  }

  try {
    const body = (await request.json()) as { snapshot?: DashboardSnapshot };
    if (!body.snapshot) {
      return Response.json({ error: "Thiếu snapshot trong body." }, { status: 400 });
    }

    const result = await writeMongoSnapshot(body.snapshot);
    return Response.json({ ok: true, result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Không thể ghi snapshot lên MongoDB." },
      { status: 500 },
    );
  }
}
