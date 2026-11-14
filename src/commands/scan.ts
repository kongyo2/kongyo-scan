import { resolve } from "node:path";

import type { AppContext } from "../app/context.js";
import { loadKeys, loadUserConfig } from "../app/context.js";
import {
  booleanOption,
  type CommandSpec,
  listOption,
  numberOption,
  type OptionSpec,
  type ParsedArgs,
  stringOption,
} from "../cli/args.js";
import { formatDuration, formatTokens, formatUsd, plural } from "../cli/format.js";
import type { Output } from "../cli/output.js";
import { type Config, FAIL_SEVERITIES, SCAN_MODES } from "../config/schema.js";
import { loadConfigFile } from "../config/store.js";
import { CliError, type NextStep } from "../core/errors.js";
import { displayPath, expandHome } from "../core/paths.js";
import { describeTarget } from "../scan/history.js";
import {
  anchorConfigPaths,
  mergeConfig,
  resolveScanPlan,
  type ScanCliOptions,
  type ScanPlan,
} from "../scan/plan.js";
import { formatCounts, formatLocation } from "../scan/results.js";
import { preflightScan, runScan, type ScanEvent, type ScanOutcome } from "../scan/runner.js";
import { BIN } from "../version.js";

export const CONFIG_ENV = "KONGYO_SCAN_CONFIG";

export const SCAN_OPTIONS: readonly OptionSpec[] = [
  {
    name: "path",
    type: "list",
    hint: "<PATH>",
    description: "Scan only these repository-relative paths, comma-separated",
  },
  {
    name: "diff",
    type: "string",
    hint: "<REF>",
    description: "Scan committed changes from this revision to --head",
  },
  {
    name: "head",
    type: "string",
    hint: "<REF>",
    description: "Head revision for --diff",
    defaultText: "HEAD",
  },
  {
    name: "working-tree",
    type: "boolean",
    description: "Scan staged and unstaged changes against --base",
  },
  {
    name: "base",
    type: "string",
    hint: "<REF>",
    description: "Base revision for --working-tree",
    defaultText: "HEAD",
  },
  {
    name: "provider",
    type: "list",
    hint: "<NAME>",
    description: "Providers to use in fallback order, comma-separated",
    defaultText: "every enabled provider, in configured order",
  },
  {
    name: "model",
    type: "string",
    hint: "<NAME>",
    description: "Model ID for the first provider in the chain",
  },
  {
    name: "effort",
    type: "string",
    hint: "<VALUE>",
    description:
      'Reasoning effort passed to the model, such as low, high, xhigh, or max; "default" sends none',
    defaultText: "xhigh",
  },
  {
    name: "fallback",
    type: "boolean",
    negated: true,
    description: "Use only the first provider; never fall back",
  },
  {
    name: "mode",
    type: "string",
    hint: "<TYPE>",
    choices: SCAN_MODES,
    description: "Scan mode: standard or deep",
    defaultText: "standard",
  },
  {
    name: "max-time",
    type: "number",
    hint: "<NUMBER>",
    description:
      "Investigation minutes: advisory in standard scans, enforced discovery limit in deep scans",
  },
  {
    name: "knowledge-base",
    type: "list",
    hint: "<PATH>",
    description: "Security-context files or directories, comma-separated",
  },
  {
    name: "scan-prompt-file",
    type: "string",
    hint: "<FILE>",
    description: "Append scan instructions from this file",
  },
  {
    name: "validation-prompt-file",
    type: "string",
    hint: "<FILE>",
    description: "Replace final validation with the workflow in this file (standard scans only)",
  },
  {
    name: "post-scan-prompt-file",
    type: "string",
    hint: "<FILE>",
    description: "Run the instructions in this file after the scan",
  },
  {
    name: "rubric",
    type: "string",
    hint: "<FILE>",
    description: "Markdown severity rubric used to grade findings",
  },
  {
    name: "owner-suggestions",
    type: "boolean",
    description: "Write owner-suggestions.json after a committed Git scan",
  },
  {
    name: "workers",
    type: "number",
    hint: "<NUMBER>",
    description: "Deep scans: maximum concurrent discovery workers",
    defaultText: "4",
  },
  {
    name: "subagents",
    type: "number",
    hint: "<NUMBER>",
    description: "Deep scans: subagents available to each worker",
    defaultText: "3",
  },
  {
    name: "stop-after-no-new",
    type: "number",
    hint: "<NUMBER>",
    description: "Deep scans: stop after this many runs find no new issues",
    defaultText: "4",
  },
  {
    name: "max-discovery-runs",
    type: "number",
    hint: "<NUMBER>",
    description: "Deep scans: maximum discovery runs",
    defaultText: "40",
  },
  {
    name: "output",
    short: "o",
    type: "string",
    hint: "<DIR>",
    description: "Directory for scan artifacts, outside the repository",
    defaultText: "kongyo-scan state",
  },
  {
    name: "archive-existing",
    type: "boolean",
    description: "Move earlier results in --output aside before scanning",
  },
  {
    name: "fail-on-severity",
    type: "string",
    hint: "<VALUE>",
    choices: FAIL_SEVERITIES,
    description:
      "Exit with code 1 for findings at or above this severity: critical, high, medium, or low",
  },
  {
    name: "max-cost",
    type: "number",
    hint: "<USD>",
    description: "Stop once the estimated cost passes this amount; every provider needs pricing",
  },
  {
    name: "config",
    type: "string",
    hint: "<FILE>",
    description: "Settings file for this scan, merged over your settings",
    defaultText: CONFIG_ENV,
  },
  {
    name: "codex",
    type: "list",
    hint: "<KEY=VALUE>",
    description: "Native Codex setting, such as analytics.enabled=false; comma-separated",
  },
  {
    name: "python",
    type: "string",
    hint: "<PATH>",
    description: "Python interpreter for Codex Security",
    defaultText: "automatic discovery",
  },
  {
    name: "dry-run",
    type: "boolean",
    description: "Validate the inputs and show what would run; start nothing",
  },
  {
    name: "verbose",
    type: "boolean",
    description: "Print each command and tool call the scan makes",
  },
  { name: "json", type: "boolean", description: "Output the result as JSON" },
];

export function scanCliOptions(args: ParsedArgs): ScanCliOptions {
  return {
    repository: args.positionals[0],
    paths: listOption(args, "path"),
    diff: stringOption(args, "diff"),
    head: stringOption(args, "head"),
    workingTree: booleanOption(args, "working-tree"),
    base: stringOption(args, "base"),
    providers: listOption(args, "provider"),
    model: stringOption(args, "model"),
    effort: stringOption(args, "effort"),
    fallback: booleanOption(args, "fallback"),
    mode: stringOption(args, "mode"),
    maxTime: numberOption(args, "max-time"),
    knowledgeBase: listOption(args, "knowledge-base"),
    scanPromptFile: stringOption(args, "scan-prompt-file"),
    validationPromptFile: stringOption(args, "validation-prompt-file"),
    postScanPromptFile: stringOption(args, "post-scan-prompt-file"),
    rubric: stringOption(args, "rubric"),
    ownerSuggestions: booleanOption(args, "owner-suggestions"),
    workers: numberOption(args, "workers"),
    subagents: numberOption(args, "subagents"),
    stopAfterNoNew: numberOption(args, "stop-after-no-new"),
    maxDiscoveryRuns: numberOption(args, "max-discovery-runs"),
    outputDir: stringOption(args, "output"),
    archiveExisting: booleanOption(args, "archive-existing"),
    failOnSeverity: stringOption(args, "fail-on-severity"),
    maxCost: numberOption(args, "max-cost"),
    codex: listOption(args, "codex"),
    python: stringOption(args, "python"),
  };
}

export interface EffectiveConfig {
  config: Config;
  projectFile: string | undefined;
}

export async function loadEffectiveConfig(
  context: AppContext,
  explicit: string | undefined,
): Promise<EffectiveConfig> {
  const user = anchorConfigPaths(
    await loadUserConfig(context),
    context.paths.configFile,
    context.env,
  );
  const selected = explicit ?? (context.env[CONFIG_ENV]?.trim() || undefined);
  if (selected === undefined) return { config: user, projectFile: undefined };
  const file = selected.startsWith("~")
    ? expandHome(selected, context.env)
    : resolve(context.cwd, selected);
  const loaded = await loadConfigFile(file);
  if (!loaded.exists) {
    throw new CliError("not_found", `Couldn't find settings file ${file}.`, {
      reason: "not_found",
      next: [{ label: "Create a starter settings file", argv: [BIN, "init"] }],
    });
  }
  return {
    config: mergeConfig(user, anchorConfigPaths(loaded.config, file, context.env)),
    projectFile: file,
  };
}

function providersLabel(plan: ScanPlan): string {
  return plan.chain.map((provider) => `${provider.name} (${provider.model})`).join(" -> ");
}

export function printPlan(output: Output, plan: ScanPlan, projectFile: string | undefined): void {
  output.row("Repository", plan.repository);
  output.row("Scope", describeTarget(plan.target));
  output.row("Mode", plan.mode);
  output.row(plan.chain.length === 1 ? "Provider" : "Providers", providersLabel(plan));
  output.row("Effort", plan.effort);
  if (projectFile !== undefined) output.row("Settings", projectFile);
}

const PHASE_LINES: Record<string, string> = {
  preflight: "Checking inputs",
  threat_model: "Building the threat model",
  discovery: "Reviewing files",
  attack_path: "Tracing attack paths",
  validation: "Validating findings",
  reporting: "Writing the report",
};

export function plainReporter(output: Output, verbose: boolean): (event: ScanEvent) => void {
  const announced = new Set<string>();
  let stage: string | undefined;
  let lastReconnect = 0;
  const ellipsis = output.err.glyph.ellipsis;
  return (event) => {
    switch (event.type) {
      case "stage":
        if (event.stage === stage) break;
        stage = event.stage;
        if (event.stage === "preparing") {
          output.info();
          output.info(`  Preparing the scan${ellipsis}`);
        } else if (event.stage === "starting") output.info(`  Starting Codex Security${ellipsis}`);
        break;
      case "registered":
        output.row("Scan ID", event.scanId);
        break;
      case "progress":
        if (announced.has(event.phase)) break;
        announced.add(event.phase);
        output.info(
          `  ${PHASE_LINES[event.phase] ?? event.phase}${ellipsis}${event.filesTotal > 0 && event.phase === "discovery" ? ` ${plural(event.filesTotal, "file")}` : ""}`,
        );
        break;
      case "deep_progress":
        if (event.consolidating && !announced.has("consolidating")) {
          announced.add("consolidating");
          output.info(`  Combining results${ellipsis}`);
        }
        break;
      case "fallback":
        output.warn(
          "provider_fallback",
          `${event.from} failed (${event.reason}). Falling back to ${event.to}.`,
        );
        break;
      case "reconnect":
        if (event.attempt !== lastReconnect) {
          lastReconnect = event.attempt;
          output.info(`  Retrying automatically${ellipsis} ${event.attempt}/${event.maxAttempts}`);
        }
        break;
      case "warning":
        output.warn("scan_warning", event.message);
        break;
      case "activity":
        if (verbose && event.status !== "running" && event.kind !== "reasoning") {
          const worker = event.worker === undefined ? "" : `[worker ${event.worker}] `;
          output.info(`    ${worker}${event.kind}: ${event.description.slice(0, 160)}`);
        }
        break;
      default:
        break;
    }
  };
}

export function outcomeNextSteps(outcome: ScanOutcome): NextStep[] {
  const steps: NextStep[] = [];
  if (outcome.findings.length > 0) {
    steps.push({
      label: "Read each finding with its evidence",
      argv: [BIN, "scans", "inspect", outcome.scanId],
    });
  }
  return steps;
}

export function outcomeDocument(outcome: ScanOutcome): Record<string, unknown> {
  return {
    scan: {
      id: outcome.scanId,
      status: outcome.status,
      repository: outcome.repository,
      target: outcome.target,
      mode: outcome.mode,
      model: outcome.model,
      effort: outcome.effort,
      providers: outcome.providers,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      durationMs: outcome.durationMs,
      scanDir: outcome.scanDir,
      reportPath: outcome.reportPath,
      findingsPath: outcome.findingsPath,
      sarifPath: outcome.sarifPath,
      threatModelPath: outcome.threatModelPath,
      usage: outcome.usage.total,
      costUsd: outcome.usage.costUsd,
    },
    findings: outcome.findings.map((finding) => ({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence ?? null,
      path: finding.path ?? null,
      startLine: finding.startLine ?? null,
      endLine: finding.endLine ?? null,
      category: finding.category ?? null,
      cwe: finding.cwe,
      summary: finding.summary,
    })),
    summary: { total: outcome.findings.length, bySeverity: outcome.counts },
    policy: {
      failOnSeverity: outcome.policy.failOnSeverity ?? null,
      breached: outcome.policy.breached,
    },
    outcome: "completed",
  };
}

export function printOutcome(output: Output, outcome: ScanOutcome): void {
  const total = outcome.findings.length;
  output.info();
  output.success(
    "Scan complete",
    total === 0 ? "No findings" : `${plural(total, "finding")} (${formatCounts(outcome.counts)})`,
  );
  output.row("Report", outcome.reportPath);
  if (outcome.sarifPath) output.row("SARIF", outcome.sarifPath);
  output.row("Scan ID", outcome.scanId);
  output.row("Duration", formatDuration(outcome.durationMs));
  if (outcome.usage.requests > 0) {
    output.row("Tokens", formatTokens(outcome.usage.total));
    if (outcome.usage.costUsd !== null)
      output.row("Cost", `${formatUsd(outcome.usage.costUsd)} (estimate)`);
  }
  if (outcome.providers.length > 1) output.row("Providers", outcome.providers.join(", "));

  if (total > 0) {
    if (output.terminal.stdout.isTTY) output.info();
    output.table(
      [{ header: "Severity" }, { header: "Location" }, { header: "Title", shrink: true }],
      outcome.findings.map((finding) => [
        finding.severity,
        formatLocation(finding) || "-",
        finding.title,
      ]),
    );
  }
  if (outcome.policy.breached) {
    output.info();
    output.warn(
      "policy_breached",
      `Findings at or above ${outcome.policy.failOnSeverity} were reported, so the exit code is 1.`,
    );
  }
}

async function runScanCommand(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const cli = scanCliOptions(args);
  const { config, projectFile } = await loadEffectiveConfig(context, stringOption(args, "config"));
  const plan = resolveScanPlan({
    cli,
    config,
    cwd: context.cwd,
    env: context.env,
    keys: await loadKeys(context),
  });

  if (booleanOption(args, "dry-run")) {
    const preflight = await preflightScan(plan, context.paths);
    if (terminal.json) {
      output.json({ scan: preflight, outcome: "planned" });
    } else {
      printPlan(output, plan, projectFile);
      output.row("State", displayPath(preflight.stateDirectory, context.env));
      if (preflight.outputDir) output.row("Output", preflight.outputDir);
      if (plan.maxTimeMinutes !== undefined)
        output.row("Time Limit", `${plan.maxTimeMinutes} minutes`);
      if (plan.maxCostUsd !== undefined) output.row("Cost Limit", formatUsd(plan.maxCostUsd));
      if (plan.failOnSeverity !== undefined) output.row("Fail On", plan.failOnSeverity);
      output.info();
      output.info("  The inputs are valid. Nothing was started.");
    }
    return 0;
  }

  if (!terminal.json) printPlan(output, plan, projectFile);

  let outcome: ScanOutcome;
  if (terminal.interactive && terminal.stderrRich && !booleanOption(args, "verbose")) {
    const { runScanWithLiveView } = await import("../tui/scan-live.js");
    outcome = await runScanWithLiveView(plan, context);
  } else {
    outcome = await runScan(plan, context.paths, {
      signal: context.signal,
      onEvent: plainReporter(output, booleanOption(args, "verbose") === true),
      ...(terminal.debug
        ? {
            onGatewayEvent: (event) =>
              terminal.stderr.write(`[gateway] ${JSON.stringify(event)}\n`),
          }
        : {}),
    });
  }

  if (terminal.json) {
    output.json(outcomeDocument(outcome), outcomeNextSteps(outcome));
  } else {
    printOutcome(output, outcome);
    output.next(outcomeNextSteps(outcome));
  }
  return outcome.policy.breached ? 1 : 0;
}

export const scanCommand: CommandSpec<AppContext> = {
  name: "scan",
  group: "Scan",
  summary: "Scan a repository, selected paths, or Git changes for vulnerabilities",
  arguments: [
    { name: "repository", description: "Repository to scan (default: current directory)" },
  ],
  options: SCAN_OPTIONS,
  examples: [
    { label: "Scan the current repository", argv: [BIN, "scan"] },
    { label: "Scan selected paths", argv: [BIN, "scan", "--path", "src,tests"] },
    {
      label: "Scan committed changes since a revision",
      argv: [BIN, "scan", "--diff", "origin/main"],
    },
    {
      label: "Fail a CI job on high or critical findings and read the result",
      argv: [BIN, "scan", "--fail-on-severity", "high", "--json"],
    },
  ],
  notes: [
    "Results go to stdout; progress and the receipt go to stderr.",
    "Exit code 0 means the scan completed. Exit code 1 means findings met --fail-on-severity, or the scan failed.",
    `${CONFIG_ENV} selects a settings file when --config is not given. No settings file is ever discovered inside the repository.`,
    "KONGYO_SCAN_BASE_URL and KONGYO_SCAN_MODEL (with KONGYO_SCAN_API_KEY and KONGYO_SCAN_WIRE_API) define a provider named env that is tried first.",
  ],
  run: runScanCommand,
};
