import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AppContext } from "../app/context.js";
import {
  booleanOption,
  type CommandSpec,
  numberOption,
  type ParsedArgs,
  stringOption,
} from "../cli/args.js";
import {
  formatAge,
  formatDuration,
  formatTimestamp,
  formatTokens,
  formatUsd,
  plural,
} from "../cli/format.js";
import type { Output } from "../cli/output.js";
import { wrapText } from "../cli/theme.js";
import { CliError, isNodeError, sanitizeText, usageError } from "../core/errors.js";
import {
  describeTarget,
  findScan,
  type HistoryRecord,
  readHistory,
  shortId,
} from "../scan/history.js";
import {
  countSeverities,
  type FindingSummary,
  formatCounts,
  formatLocation,
  readScanFindings,
} from "../scan/results.js";
import { BIN } from "../version.js";

const JSON_OPTION = {
  name: "json",
  type: "boolean",
  description: "Output the result as JSON",
} as const;
const SCAN_ARGUMENT = {
  name: "scan",
  description:
    "Scan ID or unique prefix (default: the latest scan of the current directory, otherwise the latest scan)",
} as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function recordDocument(record: HistoryRecord): Record<string, unknown> {
  return {
    id: record.scanId,
    status: record.status,
    repository: record.repository,
    target: record.target,
    mode: record.mode,
    model: record.model,
    effort: record.effort,
    providers: record.providers,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    durationMs: record.durationMs ?? null,
    scanDir: record.scanDir,
    reportPath: record.reportPath ?? null,
    sarifPath: record.sarifPath ?? null,
    threatModelPath: record.threatModelPath ?? null,
    findingCount: record.findingCount ?? null,
    findings: record.findings ?? null,
    usage: record.usage ?? null,
    costUsd: record.costUsd ?? null,
    error: record.error ?? null,
  };
}

async function listScans(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  let limit = numberOption(args, "limit") ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1)
    throw usageError(`Can't use --limit ${limit}. It must be a positive integer.`);
  if (limit > MAX_LIMIT) {
    output.warn(
      "limit_clamped",
      `--limit ${limit} is above the maximum of ${MAX_LIMIT}; showing ${MAX_LIMIT}.`,
    );
    limit = MAX_LIMIT;
  }
  const repository = stringOption(args, "repository");
  const all = await readHistory(context.paths.historyFile);
  const filtered =
    repository === undefined
      ? all
      : all.filter((record) => record.repository === resolve(context.cwd, repository));
  const shown = filtered.slice(0, limit);
  if (terminal.json) {
    output.json({
      scans: shown.map(recordDocument),
      pagination: { next: null },
      total: filtered.length,
    });
    return 0;
  }
  const columns = [
    { header: "Age" },
    { header: "Scan ID" },
    { header: "Status" },
    { header: "Findings" },
    { header: "Scope", shrink: true },
    { header: "Repository", shrink: true },
  ];
  if (shown.length === 0) {
    if (!output.out.rich) output.table(columns, []);
    output.info(
      repository === undefined
        ? "  No scans yet."
        : "  No scans match this filter. Remove --repository to see all scans.",
    );
    if (repository === undefined)
      output.next([{ label: "Run the first one", argv: [BIN, "scan"] }]);
    return 0;
  }
  output.table(
    columns,
    shown.map((record) => [
      output.out.rich ? formatAge(record.startedAt) : record.startedAt,
      output.out.rich ? shortId(record.scanId) : record.scanId,
      record.status,
      record.status === "completed"
        ? record.findingCount === 0
          ? "none"
          : formatCounts(record.findings ?? countSeverities([]))
        : "-",
      describeTarget(record.target),
      record.repository,
    ]),
  );
  if (filtered.length > shown.length) {
    output.info();
    output.info(`  Showing ${shown.length} of ${filtered.length} scans. Pass --limit to see more.`);
  }
  return 0;
}

export async function selectScan(
  context: AppContext,
  selector: string | undefined,
): Promise<HistoryRecord> {
  const records = await readHistory(context.paths.historyFile);
  if (selector === undefined) {
    const here = records.find(
      (record) => record.repository === context.cwd && record.status === "completed",
    );
    const latest = here ?? records.find((record) => record.status === "completed") ?? records[0];
    if (!latest) {
      throw new CliError("not_found", "Couldn't find a scan. None has been run yet.", {
        reason: "scan_not_found",
        next: [{ label: "Run the first one", argv: [BIN, "scan"] }],
      });
    }
    return latest;
  }
  const { record, ambiguous } = findScan(records, selector);
  if (record) return record;
  if (ambiguous.length > 1) {
    throw new CliError(
      "usage",
      `Can't pick a scan from ${selector}. ${ambiguous.length} scans start with it.`,
      {
        reason: "invalid_arguments",
        data: { scans: ambiguous.map((item) => item.scanId) },
        details: ambiguous
          .slice(0, 5)
          .map((item) => `${item.scanId}  ${item.status}  ${item.repository}`),
      },
    );
  }
  throw new CliError("not_found", `Couldn't find scan ${selector}.`, {
    reason: "scan_not_found",
    next: [{ label: "List scans", argv: [BIN, "scans", "list"] }],
  });
}

async function loadFindings(record: HistoryRecord): Promise<FindingSummary[]> {
  try {
    return await readScanFindings(record.scanDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw new CliError(
      "platform",
      `Failed to read the findings of scan ${record.scanId}. ${error instanceof Error ? error.message : String(error)}`,
      {
        reason: "internal_error",
        rows: [["Results", record.scanDir]],
        cause: error,
      },
    );
  }
}

export function printFindings(
  output: Output,
  findings: readonly FindingSummary[],
  width: number,
): void {
  const theme = output.out;
  findings.forEach((finding, index) => {
    if (index > 0) output.line();
    output.line(`${theme.bold(`${index + 1}. ${finding.title}`)}`);
    const facts = [
      finding.severity,
      finding.confidence ? `${finding.confidence} confidence` : undefined,
      formatLocation(finding) || undefined,
      finding.cwe.join(", ") || undefined,
    ]
      .filter((fact): fact is string => fact !== undefined)
      .join("  ·  ");
    output.line(`   ${facts}`);
    const section = (label: string, text: string | undefined): void => {
      if (!text) return;
      output.line();
      output.line(`   ${theme.bold(label)}`);
      for (const line of wrapText(text, Math.max(40, Math.min(width, 100) - 3)))
        output.line(`   ${line}`);
    };
    section("Summary", finding.summary);
    section("Root cause", finding.rootCause);
    section("Fix", finding.remediation);
  });
}

async function inspectScan(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const record = await selectScan(context, args.positionals[0]);
  const findings = record.status === "completed" ? await loadFindings(record) : [];
  if (terminal.json) {
    output.json({ scan: recordDocument(record), findings });
    return 0;
  }
  output.row("Scan ID", record.scanId);
  output.row("Status", record.status);
  output.row("Repository", record.repository);
  output.row("Scope", describeTarget(record.target));
  output.row("Mode", record.mode);
  output.row("Model", `${record.model} (${record.effort})`);
  if (record.providers.length > 0) output.row("Providers", record.providers.join(", "));
  output.row("Started", formatTimestamp(record.startedAt));
  if (record.durationMs !== undefined) output.row("Duration", formatDuration(record.durationMs));
  if (record.usage) output.row("Tokens", formatTokens(record.usage));
  if (record.costUsd !== undefined && record.costUsd !== null)
    output.row("Cost", `${formatUsd(record.costUsd)} (estimate)`);
  if (record.reportPath) output.row("Report", record.reportPath);
  output.row("Results", record.scanDir);
  if (record.error) output.row("Error", record.error);
  if (record.status === "completed") {
    output.row(
      "Findings",
      findings.length === 0
        ? "No findings"
        : `${plural(findings.length, "finding")} (${formatCounts(countSeverities(findings))})`,
    );
  }
  if (findings.length > 0) {
    output.info();
    printFindings(output, findings, terminal.stdoutColumns);
  }
  return 0;
}

async function reportScan(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const record = await selectScan(context, args.positionals[0]);
  const path = record.reportPath ?? join(record.scanDir, "report.md");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new CliError("not_found", `Couldn't find the report of scan ${record.scanId}.`, {
      reason: "not_found",
      rows: [
        ["Status", record.status],
        ["Results", record.scanDir],
      ],
      cause: error,
    });
  }
  if (terminal.json) output.json({ report: { scanId: record.scanId, path, markdown: text } });
  else output.write(forStdout(context, text.endsWith("\n") ? text : `${text}\n`));
  return 0;
}

// A terminal gets saved results without control characters; a pipe gets them as saved.
function forStdout(context: AppContext, text: string): string {
  return context.terminal.stdout.isTTY ? sanitizeText(text) : text;
}

const EXPORT_FORMATS = ["sarif", "json", "markdown", "csv", "threat-model"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function findingsCsv(findings: readonly FindingSummary[]): string {
  const header = [
    "severity",
    "confidence",
    "title",
    "path",
    "start_line",
    "end_line",
    "category",
    "cwe",
    "summary",
    "remediation",
  ];
  const rows = findings.map((finding) =>
    [
      finding.severity,
      finding.confidence ?? "",
      finding.title,
      finding.path ?? "",
      finding.startLine === undefined ? "" : String(finding.startLine),
      finding.endLine === undefined ? "" : String(finding.endLine),
      finding.category ?? "",
      finding.cwe.join(" "),
      finding.summary,
      finding.remediation ?? "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${[header.join(","), ...rows].join("\r\n")}\r\n`;
}

async function exportScan(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const format = (stringOption(args, "format") ?? "sarif") as ExportFormat;
  const destination = stringOption(args, "output");
  const record = await selectScan(context, args.positionals[0]);
  if (record.status !== "completed") {
    throw new CliError(
      "conflict",
      `Can't export scan ${record.scanId}. It is ${record.status}, so it has no sealed results.`,
      {
        reason: "conflict",
        next: [{ label: "List completed scans", argv: [BIN, "scans", "list"] }],
      },
    );
  }
  const sources: Record<Exclude<ExportFormat, "csv">, string> = {
    sarif: record.sarifPath ?? join(record.scanDir, "exports", "results.sarif"),
    json: join(record.scanDir, "findings.json"),
    markdown: record.reportPath ?? join(record.scanDir, "report.md"),
    "threat-model": record.threatModelPath ?? join(record.scanDir, "threatmodel.md"),
  };
  const toStdout = destination === undefined || destination === "-";
  const target = toStdout ? undefined : resolve(context.cwd, destination);
  const force = booleanOption(args, "force") === true;

  let content: string | undefined;
  if (format === "csv") content = findingsCsv(await loadFindings(record));
  const source = format === "csv" ? undefined : sources[format];

  try {
    if (target === undefined) {
      output.write(forStdout(context, content ?? (await readFile(source!, "utf8"))));
      return 0;
    }
    if (content !== undefined)
      await writeFile(target, content, { encoding: "utf8", flag: force ? "w" : "wx" });
    else
      await copyFile(
        source!,
        target,
        force ? 0 : (await import("node:fs")).constants.COPYFILE_EXCL,
      );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CliError("conflict", `Can't write ${target}. The file already exists.`, {
        reason: "file_exists",
        next: [
          {
            label: "Replace it",
            argv: [
              BIN,
              "scans",
              "export",
              record.scanId,
              "--format",
              format,
              "--output",
              destination ?? "",
              "--force",
            ],
          },
        ],
      });
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CliError(
        "not_found",
        `Couldn't find the ${format} export of scan ${record.scanId}.`,
        {
          reason: "not_found",
          rows: [["Results", record.scanDir]],
          cause: error,
        },
      );
    }
    throw error;
  }
  if (terminal.json) {
    output.json({ export: { scanId: record.scanId, format, path: target }, outcome: "exported" });
    return 0;
  }
  output.success("Exported", target);
  output.row("Format", format);
  output.row("Scan ID", record.scanId);
  if (!terminal.stdout.isTTY) output.line(target);
  return 0;
}

export const scansCommand: CommandSpec<AppContext> = {
  name: "scans",
  aliases: ["scan-history"],
  group: "Scan",
  summary: "Review past scans and their findings",
  defaultSubcommand: "list",
  subcommands: [
    {
      name: "list",
      aliases: ["ls"],
      summary: "List scans, newest first",
      options: [
        {
          name: "limit",
          short: "n",
          type: "number",
          hint: "<NUMBER>",
          description: "Number of scans to show",
          defaultText: `${DEFAULT_LIMIT}, at most ${MAX_LIMIT}`,
        },
        {
          name: "repository",
          type: "string",
          hint: "<DIR>",
          description: "Show only scans of this repository",
        },
        JSON_OPTION,
      ],
      run: listScans,
    },
    {
      name: "inspect",
      summary: "Show one scan with every finding",
      arguments: [SCAN_ARGUMENT],
      options: [JSON_OPTION],
      examples: [
        { label: "Read the findings of the latest scan here", argv: [BIN, "scans", "inspect"] },
      ],
      run: inspectScan,
    },
    {
      name: "report",
      summary: "Print the Markdown report of a scan",
      arguments: [SCAN_ARGUMENT],
      options: [JSON_OPTION],
      run: reportScan,
    },
    {
      name: "export",
      summary: "Write a scan's results as SARIF, JSON, Markdown, or CSV",
      arguments: [SCAN_ARGUMENT],
      options: [
        {
          name: "format",
          type: "string",
          hint: "<TYPE>",
          choices: EXPORT_FORMATS,
          description: `Export format: ${EXPORT_FORMATS.join(", ")}`,
          defaultText: "sarif",
        },
        {
          name: "output",
          short: "o",
          type: "string",
          hint: "<FILE>",
          description: "Destination file; - means stdout",
          defaultText: "stdout",
        },
        {
          name: "force",
          type: "boolean",
          description: "Replace the destination file if it exists",
        },
        JSON_OPTION,
      ],
      examples: [
        {
          label: "Save SARIF for a code scanning upload",
          argv: [BIN, "scans", "export", "--format", "sarif", "--output", "results.sarif"],
        },
      ],
      run: exportScan,
    },
  ],
};
