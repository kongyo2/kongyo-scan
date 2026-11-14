import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { FAIL_SEVERITIES, type FailSeverity } from "../config/schema.js";
import { sanitizeLine } from "../core/errors.js";

export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type SeverityCounts = Record<Severity, number>;

export interface FindingSummary {
  id: string;
  title: string;
  severity: Severity;
  confidence: string | undefined;
  path: string | undefined;
  startLine: number | undefined;
  endLine: number | undefined;
  category: string | undefined;
  cwe: string[];
  summary: string;
  rootCause: string | undefined;
  remediation: string | undefined;
  validation: string | undefined;
  evidence: {
    path: string;
    startLine: number | undefined;
    label: string | undefined;
    code: string | undefined;
  }[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

export function normalizeSeverity(value: unknown): Severity {
  const level = typeof value === "string" ? value.toLowerCase() : "";
  return (SEVERITIES as readonly string[]).includes(level) ? (level as Severity) : "informational";
}

export function summarizeFinding(raw: unknown, index: number): FindingSummary {
  const finding = record(raw) ?? {};
  const severity = record(finding["severity"]);
  const confidence = record(finding["confidence"]);
  const taxonomy = record(finding["taxonomy"]);
  const locations = Array.isArray(finding["locations"]) ? finding["locations"] : [];
  const primary = record(locations[0]);
  const evidence = Array.isArray(finding["codeEvidence"]) ? finding["codeEvidence"] : [];
  return {
    id: text(finding["findingId"]) ?? text(finding["occurrenceId"]) ?? `finding-${index + 1}`,
    title: sanitizeLine(text(finding["title"]) ?? "Untitled finding"),
    severity: normalizeSeverity(severity?.["level"]),
    confidence: text(confidence?.["level"]),
    path: text(primary?.["path"]),
    startLine: integer(primary?.["startLine"]),
    endLine: integer(primary?.["endLine"]),
    category: text(taxonomy?.["category"]),
    cwe: Array.isArray(taxonomy?.["cwe"])
      ? taxonomy["cwe"].filter((item): item is string => typeof item === "string")
      : [],
    summary: text(finding["summary"]) ?? "",
    rootCause: text(record(finding["rootCause"])?.["summary"]),
    remediation: text(finding["remediation"]),
    validation: text(record(finding["validation"])?.["summary"]),
    evidence: evidence.flatMap((entry) => {
      const item = record(entry);
      const path = text(item?.["path"]);
      if (!item || path === undefined) return [];
      return [
        {
          path,
          startLine: integer(item["startLine"]),
          label: text(item["label"]),
          code: text(item["code"]),
        },
      ];
    }),
  };
}

export function summarizeFindings(document: unknown): FindingSummary[] {
  const findings = record(document)?.["findings"];
  if (!Array.isArray(findings)) return [];
  return findings
    .map((finding, index) => summarizeFinding(finding, index))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

export function countSeverities(
  findings: readonly Pick<FindingSummary, "severity">[],
): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function breachesPolicy(
  findings: readonly Pick<FindingSummary, "severity">[],
  threshold: FailSeverity | undefined,
): boolean {
  if (threshold === undefined) return false;
  const limit = (FAIL_SEVERITIES as readonly string[]).indexOf(threshold);
  return findings.some((finding) => {
    const rank = (SEVERITIES as readonly string[]).indexOf(finding.severity);
    return rank >= 0 && rank <= limit;
  });
}

export function formatCounts(counts: SeverityCounts): string {
  const parts = SEVERITIES.filter((level) => counts[level] > 0).map(
    (level) => `${counts[level]} ${level}`,
  );
  return parts.length === 0 ? "none" : parts.join(", ");
}

export function formatLocation(finding: Pick<FindingSummary, "path" | "startLine">): string {
  if (finding.path === undefined) return "";
  return finding.startLine === undefined ? finding.path : `${finding.path}:${finding.startLine}`;
}

export async function readScanFindings(scanDir: string): Promise<FindingSummary[]> {
  const source = await readFile(join(scanDir, "findings.json"), "utf8");
  return summarizeFindings(JSON.parse(source) as unknown);
}
