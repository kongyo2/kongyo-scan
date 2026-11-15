import { dirname, isAbsolute, resolve } from "node:path";

import type { StoredKeys } from "../config/credentials.js";
import {
  type Config,
  DEFAULT_REASONING_EFFORT,
  FAIL_SEVERITIES,
  type FailSeverity,
  type JsonObject,
  type JsonValue,
  RESERVED_CODEX_KEYS,
  SCAN_MODES,
} from "../config/schema.js";
import { CliError, usageError } from "../core/errors.js";
import { expandHome } from "../core/paths.js";
import type { ResolvedProvider } from "../gateway/types.js";
import { buildChain, missingProviderError } from "../providers/resolve.js";
import type { TargetDescription } from "./history.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface ScanCliOptions {
  repository?: string | undefined;
  paths?: string[] | undefined;
  diff?: string | undefined;
  head?: string | undefined;
  workingTree?: boolean | undefined;
  base?: string | undefined;
  providers?: string[] | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  fallback?: boolean | undefined;
  mode?: string | undefined;
  maxTime?: number | undefined;
  knowledgeBase?: string[] | undefined;
  scanPromptFile?: string | undefined;
  validationPromptFile?: string | undefined;
  postScanPromptFile?: string | undefined;
  rubric?: string | undefined;
  ownerSuggestions?: boolean | undefined;
  workers?: number | undefined;
  subagents?: number | undefined;
  stopAfterNoNew?: number | undefined;
  maxDiscoveryRuns?: number | undefined;
  outputDir?: string | undefined;
  archiveExisting?: boolean | undefined;
  failOnSeverity?: string | undefined;
  maxCost?: number | undefined;
  codex?: string[] | undefined;
  python?: string | undefined;
}

export interface GatewaySettings {
  port: number;
  cooldownMs: number;
  idleTimeoutMs: number;
  maxRequestRetries: number;
}

export interface ScanPlan {
  repository: string;
  target: TargetDescription;
  mode: "standard" | "deep";
  effort: string;
  chain: ResolvedProvider[];
  maxTimeMinutes: number | undefined;
  knowledgeBase: string[];
  scanPromptFile: string | undefined;
  validationPromptFile: string | undefined;
  postScanPromptFile: string | undefined;
  rubricFile: string | undefined;
  ownerSuggestions: boolean;
  outputDir: string | undefined;
  archiveExisting: boolean;
  failOnSeverity: FailSeverity | undefined;
  maxCostUsd: number | undefined;
  deep: {
    workers: number | undefined;
    subagents: number | undefined;
    stopAfterNoNew: number | undefined;
    stopAfterConsecutiveErrors: number | undefined;
    maxDiscoveryRuns: number | undefined;
  };
  codex: JsonObject;
  python: string | undefined;
  gateway: GatewaySettings;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(base: Config, override: Config): Config {
  const merge = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const existing = result[key];
      result[key] = isObject(value) && isObject(existing) ? merge(existing, value) : value;
    }
    return result;
  };
  return merge(base as Record<string, unknown>, override as Record<string, unknown>) as Config;
}

export function anchorConfigPaths(
  config: Config,
  configFile: string,
  env: Env = process.env,
): Config {
  const directory = dirname(configFile);
  const anchor = (path: string): string =>
    path.startsWith("~")
      ? expandHome(path, env)
      : isAbsolute(path)
        ? path
        : resolve(directory, path);
  const anchored: Config = structuredClone(config);
  if (anchored.scan) {
    const scan = anchored.scan;
    if (scan.knowledge_base) scan.knowledge_base = scan.knowledge_base.map(anchor);
    if (scan.instructions_file) scan.instructions_file = anchor(scan.instructions_file);
    if (scan.validation_file) scan.validation_file = anchor(scan.validation_file);
    if (scan.post_scan_file) scan.post_scan_file = anchor(scan.post_scan_file);
    if (scan.rubric_file) scan.rubric_file = anchor(scan.rubric_file);
  }
  if (anchored.output?.directory) anchored.output.directory = anchor(anchored.output.directory);
  if (anchored.python && /[\\/]/u.test(anchored.python)) anchored.python = anchor(anchored.python);
  return anchored;
}

export function parseCodexAssignments(assignments: readonly string[]): JsonObject {
  const result: JsonObject = {};
  const seen = new Set<string>();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const key = separator < 0 ? "" : assignment.slice(0, separator).trim();
    if (separator <= 0 || key === "") {
      throw usageError(
        `Can't use --codex ${assignment}. Write it as KEY=VALUE, such as analytics.enabled=false.`,
      );
    }
    if (seen.has(key)) throw usageError(`Can't set --codex ${key} twice.`);
    seen.add(key);
    const segments = key.split(".");
    if (
      segments.some(
        (segment) => segment === "" || ["__proto__", "constructor", "prototype"].includes(segment),
      )
    ) {
      throw usageError(`Can't use --codex ${assignment}. ${key} isn't a valid setting name.`);
    }
    assertCodexKeyAllowed(segments[0]!, "--codex");
    let target: JsonObject = result;
    for (const segment of segments.slice(0, -1)) {
      const next = target[segment];
      if (next === undefined) {
        const created: JsonObject = {};
        target[segment] = created;
        target = created;
      } else if (isObject(next)) {
        target = next as JsonObject;
      } else {
        throw usageError(`Can't set --codex ${key}. ${segment} already has a value.`);
      }
    }
    target[segments.at(-1)!] = parseCodexValue(assignment.slice(separator + 1));
  }
  return result;
}

function parseCodexValue(raw: string): JsonValue {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return raw;
  }
}

function assertCodexKeyAllowed(key: string, source: string): void {
  if (!(RESERVED_CODEX_KEYS as readonly string[]).includes(key)) return;
  throw usageError(
    `Can't set ${key} through ${source}. kongyo-scan manages it from the provider chain.`,
    {
      hint:
        key === "model_reasoning_effort"
          ? "Use --effort or the reasoning_effort setting."
          : key === "model"
            ? "Use --model or set the model on a provider."
            : "Configure providers with kongyo-scan providers.",
    },
  );
}

export function assertCodexSettingsAllowed(codex: JsonObject, source: string): void {
  for (const key of Object.keys(codex)) assertCodexKeyAllowed(key, source);
}

function resolveTarget(cli: ScanCliOptions, config: Config): TargetDescription {
  const selectors = [
    cli.paths && cli.paths.length > 0 ? "--path" : undefined,
    cli.diff !== undefined ? "--diff" : undefined,
    cli.workingTree === true ? "--working-tree" : undefined,
  ].filter((selector): selector is string => selector !== undefined);
  if (selectors.length > 1) {
    throw usageError(`Can't use ${selectors[0]} with ${selectors[1]}. Choose one scope.`);
  }

  const scope = config.scan?.scope;
  let target: TargetDescription = { kind: "repository" };
  if (scope && "paths" in scope) target = { kind: "paths", paths: [...scope.paths] };
  else if (scope && "diff" in scope) {
    target = {
      kind: "diff",
      base: scope.diff.base,
      ...(scope.diff.head ? { head: scope.diff.head } : {}),
    };
  } else if (scope && "working_tree" in scope && cli.workingTree !== false) {
    target = {
      kind: "working_tree",
      ...(scope.working_tree.base ? { base: scope.working_tree.base } : {}),
    };
  }

  if (cli.paths && cli.paths.length > 0) target = { kind: "paths", paths: [...cli.paths] };
  else if (cli.diff !== undefined) target = { kind: "diff", base: cli.diff };
  else if (cli.workingTree === true) target = { kind: "working_tree" };

  if (cli.head !== undefined) {
    if (target.kind !== "diff") throw usageError("Can't use --head without --diff.");
    target = { ...target, head: cli.head };
  }
  if (cli.base !== undefined) {
    if (target.kind !== "working_tree")
      throw usageError("Can't use --base without --working-tree.");
    target = { ...target, base: cli.base };
  }
  if (target.kind === "paths") {
    for (const path of target.paths ?? []) {
      if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
        throw usageError(
          `Can't scan path ${path}. Paths are relative to the repository and stay inside it.`,
        );
      }
    }
  }
  return target;
}

export interface PlanInputs {
  cli: ScanCliOptions;
  config: Config;
  cwd: string;
  env?: Env;
  keys?: StoredKeys;
}

export function resolveScanPlan(inputs: PlanInputs): ScanPlan {
  const { cli, config, cwd } = inputs;
  const env = inputs.env ?? process.env;
  const fromCwd = (path: string): string =>
    path.startsWith("~") ? expandHome(path, env) : resolve(cwd, path);

  const mode = cli.mode ?? config.scan?.mode ?? "standard";
  if (!(SCAN_MODES as readonly string[]).includes(mode)) {
    throw usageError(`Can't use --mode ${mode}. Use standard or deep.`);
  }
  const target = resolveTarget(cli, config);
  if (mode === "deep" && (target.kind === "diff" || target.kind === "working_tree")) {
    throw usageError(
      "Can't run a deep scan on a diff. Deep scans cover the repository or selected paths.",
    );
  }

  const deepFlags: [string, number | undefined][] = [
    ["--workers", cli.workers],
    ["--subagents", cli.subagents],
    ["--stop-after-no-new", cli.stopAfterNoNew],
    ["--max-discovery-runs", cli.maxDiscoveryRuns],
  ];
  for (const [flag, value] of deepFlags) {
    if (value === undefined) continue;
    if (mode !== "deep") throw usageError(`Can't use ${flag} without --mode deep.`);
    const minimum = flag === "--subagents" ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw usageError(
        `Can't use ${flag} ${value}. It must be ${minimum === 0 ? "a non-negative" : "a positive"} integer.`,
      );
    }
  }

  const failOnSeverity = cli.failOnSeverity ?? config.policy?.fail_on_severity;
  if (
    failOnSeverity !== undefined &&
    !(FAIL_SEVERITIES as readonly string[]).includes(failOnSeverity)
  ) {
    throw usageError(
      `Can't use --fail-on-severity ${failOnSeverity}. Use critical, high, medium, or low.`,
    );
  }

  const maxTimeMinutes = cli.maxTime ?? config.scan?.max_time_minutes;
  if (maxTimeMinutes !== undefined && !(maxTimeMinutes > 0)) {
    throw usageError(
      `Can't use --max-time ${maxTimeMinutes}. It must be a positive number of minutes.`,
    );
  }
  if (maxTimeMinutes !== undefined && mode === "deep" && maxTimeMinutes > 5760) {
    throw usageError(
      `Can't use --max-time ${maxTimeMinutes}. Deep scans allow at most 5760 minutes.`,
    );
  }

  const maxCostUsd = cli.maxCost ?? config.limits?.max_cost_usd_per_scan;
  if (maxCostUsd !== undefined && !(maxCostUsd > 0)) {
    throw usageError(`Can't use --max-cost ${maxCostUsd}. It must be a positive amount in USD.`);
  }

  const validationPromptFile =
    cli.validationPromptFile !== undefined
      ? fromCwd(cli.validationPromptFile)
      : config.scan?.validation_file;
  if (validationPromptFile !== undefined && mode === "deep") {
    throw usageError(
      "Can't use a validation prompt with --mode deep. Custom validation runs in standard scans only.",
    );
  }

  const chain = buildChain(
    config,
    { names: cli.providers, model: cli.model, noFallback: cli.fallback === false },
    env,
    inputs.keys ?? {},
  );
  if (chain.length === 0) throw missingProviderError();
  if (maxCostUsd !== undefined) {
    const unpriced = chain
      .filter((provider) => provider.pricing === undefined)
      .map((provider) => provider.name);
    if (unpriced.length > 0) {
      throw new CliError(
        "usage",
        `Can't enforce a cost limit. ${unpriced.length === 1 ? `Provider ${unpriced[0]} has` : `Providers ${unpriced.join(", ")} have`} no pricing.`,
        {
          reason: "invalid_arguments",
          next: [
            {
              label: "Add token prices in USD per 1M tokens",
              argv: [
                "kongyo-scan",
                "config",
                "set",
                `providers.${unpriced[0]}.pricing`,
                '{"input_per_mtok":<USD>,"output_per_mtok":<USD>}',
              ],
            },
          ],
        },
      );
    }
  }

  const codexFromCli = parseCodexAssignments(cli.codex ?? []);
  const codexFromConfig = (config.codex ?? {}) as JsonObject;
  assertCodexSettingsAllowed(codexFromConfig, "the codex setting");
  const codex = mergeConfig({ codex: codexFromConfig }, { codex: codexFromCli })
    .codex as JsonObject;

  return {
    repository: resolve(cwd, cli.repository ?? "."),
    target,
    mode: mode as "standard" | "deep",
    effort: cli.effort ?? config.reasoning_effort ?? DEFAULT_REASONING_EFFORT,
    chain,
    maxTimeMinutes,
    knowledgeBase: cli.knowledgeBase
      ? cli.knowledgeBase.map(fromCwd)
      : (config.scan?.knowledge_base ?? []),
    scanPromptFile:
      cli.scanPromptFile !== undefined
        ? fromCwd(cli.scanPromptFile)
        : config.scan?.instructions_file,
    validationPromptFile,
    postScanPromptFile:
      cli.postScanPromptFile !== undefined
        ? fromCwd(cli.postScanPromptFile)
        : config.scan?.post_scan_file,
    rubricFile: cli.rubric !== undefined ? fromCwd(cli.rubric) : config.scan?.rubric_file,
    ownerSuggestions: cli.ownerSuggestions ?? config.scan?.owner_suggestions ?? false,
    outputDir: cli.outputDir !== undefined ? fromCwd(cli.outputDir) : config.output?.directory,
    archiveExisting: cli.archiveExisting ?? false,
    failOnSeverity: failOnSeverity as FailSeverity | undefined,
    maxCostUsd,
    deep: {
      workers: cli.workers ?? config.scan?.deep?.workers,
      subagents: cli.subagents ?? config.scan?.deep?.subagents_per_worker,
      stopAfterNoNew: cli.stopAfterNoNew ?? config.scan?.deep?.stop_after_no_new,
      stopAfterConsecutiveErrors: config.scan?.deep?.stop_after_consecutive_errors,
      maxDiscoveryRuns: cli.maxDiscoveryRuns ?? config.scan?.deep?.max_discovery_runs,
    },
    codex,
    python:
      cli.python !== undefined
        ? /[\\/]/u.test(cli.python)
          ? fromCwd(cli.python)
          : cli.python
        : config.python,
    gateway: {
      port: config.gateway?.port ?? 0,
      cooldownMs: (config.gateway?.cooldown_seconds ?? 60) * 1000,
      idleTimeoutMs: (config.gateway?.stream_idle_timeout_seconds ?? 300) * 1000,
      maxRequestRetries: config.gateway?.max_request_retries ?? 5,
    },
  };
}
