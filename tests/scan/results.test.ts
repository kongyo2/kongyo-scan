import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendHistory,
  describeTarget,
  findScan,
  type HistoryRecord,
  readHistory,
  shortId,
} from "../../src/scan/history.js";
import {
  breachesPolicy,
  countSeverities,
  formatCounts,
  formatLocation,
  readScanFindings,
  summarizeFindings,
} from "../../src/scan/results.js";

const DOCUMENT = {
  findings: [
    {
      findingId: "csf_low",
      title: "Verbose error\u001b[31m output",
      severity: { level: "Low" },
      locations: [{ path: "src/a.js" }],
      summary: "Stack traces reach the client.",
    },
    {
      findingId: "csf_high",
      title: "SQL injection",
      severity: { level: "high" },
      confidence: { level: "high" },
      taxonomy: { category: "sql injection", cwe: ["CWE-89", 7] },
      locations: [{ path: "src/server.js", startLine: 11, endLine: 14 }],
      summary: "User input reaches a query.",
      rootCause: { summary: "String concatenation." },
      remediation: "Use parameters.",
      validation: { summary: "Reproduced." },
      codeEvidence: [
        { path: "src/server.js", startLine: 12, label: "sink", code: "db.all(q)" },
        { label: "no path" },
      ],
    },
    { title: "Unrated", severity: { level: "weird" } },
  ],
};

describe("finding summaries", () => {
  it("reduces raw findings and orders them by severity", () => {
    const findings = summarizeFindings(DOCUMENT);
    expect(findings.map((finding) => finding.id)).toEqual(["csf_high", "csf_low", "finding-3"]);
    expect(findings[0]).toMatchObject({
      severity: "high",
      confidence: "high",
      path: "src/server.js",
      startLine: 11,
      endLine: 14,
      category: "sql injection",
      cwe: ["CWE-89"],
      rootCause: "String concatenation.",
      remediation: "Use parameters.",
      validation: "Reproduced.",
      evidence: [{ path: "src/server.js", startLine: 12, label: "sink", code: "db.all(q)" }],
    });
    expect(findings[1]!.severity).toBe("low");
    expect(findings[1]!.title).not.toContain("\u001b");
    expect(findings[2]).toMatchObject({
      severity: "informational",
      title: "Unrated",
      cwe: [],
      evidence: [],
    });
    expect(summarizeFindings({})).toEqual([]);
    expect(summarizeFindings(null)).toEqual([]);
  });

  it("counts and formats severities", () => {
    const counts = countSeverities(summarizeFindings(DOCUMENT));
    expect(counts).toEqual({ critical: 0, high: 1, medium: 0, low: 1, informational: 1 });
    expect(formatCounts(counts)).toBe("1 high, 1 low, 1 informational");
    expect(formatCounts(countSeverities([]))).toBe("none");
    expect(formatLocation({ path: "a.js", startLine: 3 })).toBe("a.js:3");
    expect(formatLocation({ path: "a.js", startLine: undefined })).toBe("a.js");
    expect(formatLocation({ path: undefined, startLine: 3 })).toBe("");
  });

  it("applies the failure policy at and above the threshold", () => {
    const findings = [{ severity: "medium" as const }, { severity: "informational" as const }];
    expect(breachesPolicy(findings, undefined)).toBe(false);
    expect(breachesPolicy(findings, "high")).toBe(false);
    expect(breachesPolicy(findings, "medium")).toBe(true);
    expect(breachesPolicy(findings, "low")).toBe(true);
    expect(breachesPolicy([{ severity: "informational" }], "low")).toBe(false);
    expect(breachesPolicy([{ severity: "critical" }], "critical")).toBe(true);
  });
});

describe("scan history", () => {
  let directory: string;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kscan-history-"));
    file = join(directory, "nested", "history.jsonl");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function entry(overrides: Partial<HistoryRecord>): HistoryRecord {
    return {
      scanId: "aaaaaaaa-0000-4000-8000-000000000001",
      status: "completed",
      repository: "/repo",
      target: { kind: "repository" },
      mode: "standard",
      startedAt: "2026-01-01T00:00:00.000Z",
      scanDir: "/state/scan",
      providers: ["primary"],
      model: "m",
      effort: "high",
      ...overrides,
    };
  }

  it("keeps the last record per scan, newest first", async () => {
    expect(await readHistory(file)).toEqual([]);
    await appendHistory(file, entry({ status: "running", pid: process.pid }));
    await appendHistory(
      file,
      entry({
        scanId: "bbbbbbbb-0000-4000-8000-000000000002",
        startedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await appendHistory(file, entry({ status: "completed", findingCount: 2 }));
    await writeFile(file, `${await readFile(file, "utf8")}{"scanId":"torn`, "utf8");
    const records = await readHistory(file);
    expect(records.map((record) => [shortId(record.scanId), record.status])).toEqual([
      ["bbbbbbbb", "completed"],
      ["aaaaaaaa", "completed"],
    ]);
    expect(records[1]!.findingCount).toBe(2);
  });

  it("reads a running scan whose process is gone as interrupted", async () => {
    await appendHistory(file, entry({ status: "running", pid: 2 ** 22 + 12345 }));
    await appendHistory(
      file,
      entry({
        scanId: "cccccccc-0000-4000-8000-000000000003",
        status: "running",
        pid: process.pid,
      }),
    );
    const records = await readHistory(file);
    expect(records.find((record) => record.scanId.startsWith("aaaa"))!.status).toBe("interrupted");
    expect(records.find((record) => record.scanId.startsWith("cccc"))!.status).toBe("running");
  });

  it("finds scans by ID or unique prefix and never guesses", () => {
    const records = [
      entry({}),
      entry({ scanId: "aaaabbbb-0000-4000-8000-000000000009" }),
      entry({ scanId: "dddddddd-0000-4000-8000-000000000004" }),
    ];
    expect(findScan(records, "DDDD").record?.scanId).toBe("dddddddd-0000-4000-8000-000000000004");
    expect(findScan(records, "aaaaaaaa-0000-4000-8000-000000000001").record?.scanId).toBe(
      "aaaaaaaa-0000-4000-8000-000000000001",
    );
    const ambiguous = findScan(records, "aaaa");
    expect(ambiguous.record).toBeUndefined();
    expect(ambiguous.ambiguous).toHaveLength(2);
    expect(findScan(records, "zzz")).toEqual({ ambiguous: [] });
  });

  it("describes targets", () => {
    expect(describeTarget({ kind: "repository" })).toBe("repository");
    expect(describeTarget({ kind: "paths", paths: ["src", "lib"] })).toBe("src, lib");
    expect(describeTarget({ kind: "diff", base: "main" })).toBe("main..HEAD");
    expect(describeTarget({ kind: "diff", base: "main", head: "topic" })).toBe("main..topic");
    expect(describeTarget({ kind: "working_tree" })).toBe("working tree vs HEAD");
  });

  it("loads findings from a scan directory", async () => {
    await writeFile(join(directory, "findings.json"), JSON.stringify(DOCUMENT), "utf8");
    const findings = await readScanFindings(directory);
    expect(findings).toHaveLength(3);
    expect(findings[0]!.title).toBe("SQL injection");
  });
});
