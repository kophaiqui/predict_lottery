import "server-only";

import { LOTTERY_CONFIG } from "./lottery-config";
import { createId, formatDate, uniqueSorted } from "./number-utils";
import { replaceActualDraws, upsertActualDraws } from "./mongodb";
import type { DrawRecord, LotteryType } from "./types";
import { VIETLOTT_DATA_SOURCES, type VietlottDataLotteryType } from "./vietlott-data-config";

const SOURCE_TAG = "github:vietvudanh/vietlott-data";

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function parseDate(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const dmy = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
}

function coerceNumberList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item))
      .map((item) => Math.trunc(item));
  }

  const text = asString(value);
  if (!text) return [];
  return text.match(/\d{1,2}/g)?.map(Number) ?? [];
}

function csvSplit(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function normalizeJsonRows(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => normalizeJsonRows(item));
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  for (const key of ["data", "rows", "items", "results"] as const) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.flatMap((item) => normalizeJsonRows(item));
    }
  }

  return [record];
}

function parseDataset(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    return normalizeJsonRows(JSON.parse(trimmed));
  } catch {
    // Continue with JSONL / CSV detection.
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) {
    const jsonlRows: Record<string, unknown>[] = [];
    let parsedLines = 0;

    for (const line of lines) {
      try {
        jsonlRows.push(...normalizeJsonRows(JSON.parse(line)));
        parsedLines += 1;
      } catch {
        // Ignore non-JSON line.
      }
    }

    if (parsedLines > 0 && parsedLines >= Math.max(1, lines.length - 1)) {
      return jsonlRows;
    }
  }

  const [headerLine, ...dataLines] = lines;
  if (!headerLine || !headerLine.includes(",")) {
    return [];
  }

  const headers = csvSplit(headerLine);
  return dataLines.map((line) => {
    const cells = csvSplit(line);
    return headers.reduce<Record<string, unknown>>((accumulator, header, index) => {
      accumulator[header] = cells[index] ?? "";
      return accumulator;
    }, {});
  });
}

function normalizeDrawRow(
  lotteryType: LotteryType,
  row: Record<string, unknown>,
): DrawRecord | null {
  const config = LOTTERY_CONFIG[lotteryType];
  const source = VIETLOTT_DATA_SOURCES[lotteryType as VietlottDataLotteryType];
  const importedAt = new Date().toISOString();
  const drawDate = parseDate(row.date ?? row.drawDate ?? row.draw_date ?? row.day);
  const rawDrawId = asString(row.id ?? row.drawId ?? row.draw_id);
  const resultValues = coerceNumberList(row.result ?? row.numbers ?? row.values ?? row.draw_numbers);
  const explicitBonusNumbers = coerceNumberList(
    row.bonusNumbers ?? row.bonus_numbers ?? row.specialNumber ?? row.special_number,
  );

  const numbers = uniqueSorted(resultValues.slice(0, config.pickCount)).filter((number) => number >= 1 && number <= config.maxNumber);
  const bonusNumbers = config.hasBonus
    ? uniqueSorted(
        explicitBonusNumbers.length ? explicitBonusNumbers : resultValues.slice(config.pickCount),
      ).filter((number) => number >= 1 && number <= config.maxNumber)
    : [];

  if (!drawDate || !rawDrawId || numbers.length !== config.pickCount) {
    return null;
  }

  if (numbers.some((number) => number < 1 || number > config.maxNumber)) {
    return null;
  }

  return {
    lotteryType,
    drawDate,
    drawId: rawDrawId || createId(lotteryType, drawDate, numbers.join("")),
    numbers,
    bonusNumbers,
    jackpotData: {},
    sourceUrl: source.rawUrl,
    source: SOURCE_TAG,
    importedAt,
    crawledAt: asString(row.process_time ?? row.processTime ?? row.crawledAt) ?? importedAt,
    createdAt: importedAt,
    updatedAt: importedAt,
  };
}

export async function importVietlottData(
  lotteryType: VietlottDataLotteryType,
  options: { replaceExisting?: boolean; latestCount?: number } = {},
) {
  const source = VIETLOTT_DATA_SOURCES[lotteryType];
  const response = await fetch(source.rawUrl, {
    headers: {
      "User-Agent": "predict-lottery-dashboard/1.0",
      Accept: "text/plain, application/json;q=0.9, */*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub data: HTTP ${response.status}`);
  }

  const text = await response.text();
  const rows = parseDataset(text);
  const normalized = rows
    .map((row) => normalizeDrawRow(lotteryType as LotteryType, row))
    .filter((row): row is DrawRecord => Boolean(row));

  const unique = new Map<string, DrawRecord>();
  for (const record of normalized) {
    unique.set(`${record.lotteryType}:${record.drawDate}`, record);
  }

  const allRecords = [...unique.values()].sort((a, b) => a.drawDate.localeCompare(b.drawDate));
  const records =
    options.latestCount && options.latestCount > 0
      ? allRecords.slice(-options.latestCount)
      : allRecords;
  if (!records.length) {
    throw new Error(`No valid records parsed from ${source.rawUrl}`);
  }

  const result = options.replaceExisting
    ? await replaceActualDraws(lotteryType as LotteryType, records)
    : { deleted: 0, ...(await upsertActualDraws(records)) };
  const latestDrawDate = records.at(-1)?.drawDate ?? null;

  return {
    lotteryType,
    sourceUrl: source.rawUrl,
    replaced: options.replaceExisting ?? false,
    deleted: result.deleted,
    records,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped + Math.max(0, normalized.length - records.length),
    latestDrawDate,
  };
}
