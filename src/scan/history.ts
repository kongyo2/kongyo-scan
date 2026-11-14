import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { isNodeError } from "../core/errors.js";
import type { TokenUsage } from "../gateway/types.js";
import type { SeverityCounts } from "./results.js";

export type ScanStatus = "running" | "completed" | "failed" | "canceled" | "interrupted";

export interface TargetDescription {
  kind: "repository" | "paths" | "diff" | "working_tree";
  paths?: string[];
  base?: string;
  head?: string;
}

export interface HistoryRecord {
  scanId: string;
  status: ScanStatus;
  repository: string;
  target: TargetDescription;
  mode: string;
  startedAt: string;
  finishedAt?: string;
  scanDir: string;
  reportPath?: string;
  sarifPath?: string | null;
  threatModelPath?: string | null;
  findings?: SeverityCounts;
  findingCount?: number;
  providers: string[];
  model: string;
  effort: string;
  usage?: TokenUsage;
  costUsd?: number | null;
  durationMs?: number;
  error?: string;
  pid?: number;
}

export async function appendHistory(file: string, record: HistoryRecord): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

export async function readHistory(file: string): Promise<HistoryRecord[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const latest = new Map<string, HistoryRecord>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as HistoryRecord;
      if (typeof record.scanId === "string" && typeof record.startedAt === "string")
        latest.set(record.scanId, record);
    } catch {
      // A torn final line from an interrupted write; skip it.
    }
  }
  return [...latest.values()]
    .map((record) =>
      record.status === "running" && !alive(record.pid)
        ? { ...record, status: "interrupted" as const }
        : record,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function findScan(
  records: readonly HistoryRecord[],
  selector: string,
): { record?: HistoryRecord; ambiguous: HistoryRecord[] } {
  const wanted = selector.toLowerCase();
  const exact = records.find((record) => record.scanId.toLowerCase() === wanted);
  if (exact) return { record: exact, ambiguous: [] };
  const matches = records.filter((record) => record.scanId.toLowerCase().startsWith(wanted));
  if (matches.length === 1) return { record: matches[0]!, ambiguous: [] };
  return { ambiguous: matches };
}

export function shortId(scanId: string): string {
  return scanId.slice(0, 8);
}

export function describeTarget(target: TargetDescription): string {
  switch (target.kind) {
    case "paths":
      return (target.paths ?? []).join(", ");
    case "diff":
      return `${target.base ?? "?"}..${target.head ?? "HEAD"}`;
    case "working_tree":
      return `working tree vs ${target.base ?? "HEAD"}`;
    default:
      return "repository";
  }
}
