import type { CrawlQualityIssue, CrawlQualityReport, DrawRecord, LotteryConfig } from "./types";
import { formatDate } from "./number-utils";

function issue(code: CrawlQualityIssue["code"], severity: CrawlQualityIssue["severity"], message: string): CrawlQualityIssue {
  return { code, severity, message };
}

export function validateCrawlBatch(params: {
  lotteryType: string;
  records: DrawRecord[];
  config: LotteryConfig;
  existingDraws: DrawRecord[];
}): CrawlQualityReport {
  const { records, config, existingDraws } = params;
  const issues: CrawlQualityIssue[] = [];
  const seenIds = new Set(existingDraws.map((draw) => draw.drawId));
  const seenDates = new Set(existingDraws.map((draw) => draw.drawDate));

  for (const record of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.drawDate)) {
      issues.push(issue("bad-date", "error", `Ngày quay không hợp lệ: ${record.drawDate}`));
    }

    if (seenIds.has(record.drawId) || seenDates.has(record.drawDate)) {
      issues.push(issue("duplicate-draw", "warn", `Trùng kỳ quay: ${record.drawId}`));
    }

    const expectedCount = config.drawCount ?? config.pickCount;
    if (record.numbers.length !== expectedCount) {
      issues.push(
        issue(
          "invalid-number-count",
          "error",
          `Sai số lượng số: ${record.drawId} có ${record.numbers.length}, expected ${expectedCount}`,
        ),
      );
    }

    if (record.numbers.some((number) => number < 1 || number > config.maxNumber)) {
      issues.push(issue("out-of-range", "error", `Số ngoài range trong ${record.drawId}`));
    }

    if (config.hasBonus && record.bonusNumbers.length === 0) {
      issues.push(issue("missing-bonus", "warn", `Thiếu bonus number ở ${record.drawId}`));
    }

    const sourceMarker = `${record.source ?? ""} ${record.sourceUrl ?? ""}`.toLowerCase();
    if (!sourceMarker.includes("vietlott") && !sourceMarker.includes("github") && !sourceMarker.includes("raw.githubusercontent.com")) {
      issues.push(issue("format-changed", "warn", `Nguồn hoặc format website có thể thay đổi ở ${record.drawId}`));
    }
  }

  const accepted = !issues.some((entry) => entry.severity === "error");
  return {
    accepted,
    issues,
    acceptedCount: accepted ? records.length : 0,
    rejectedCount: accepted ? 0 : records.length,
  };
}

export function summarizeQuality(report: CrawlQualityReport): string {
  if (report.accepted) {
    return `Dữ liệu hợp lệ. ${report.acceptedCount} bản ghi có thể dùng cho model.`;
  }

  const errorCount = report.issues.filter((issue) => issue.severity === "error").length;
  return `Dữ liệu bị chặn bởi ${errorCount} lỗi.`;
}

export function makeCrawlLogMessage(report: CrawlQualityReport) {
  return {
    status: report.accepted ? "success" : "error",
    message: summarizeQuality(report),
    issues: report.issues,
    checkedAt: formatDate(new Date()),
  };
}
