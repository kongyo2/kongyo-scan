import { mkdir } from "node:fs/promises";

import type { ScanOptions, ScanResult } from "@openai/codex-security";

import { EFFORT_PROVIDER_DEFAULT, type JsonObject } from "../config/schema.js";
import { CanceledError, CliError, describeError, sanitizeLine } from "../core/errors.js";
import type { AppPaths } from "../core/paths.js";
import { representativeFailure } from "../gateway/failure.js";
import { type Gateway, startGateway } from "../gateway/server.js";
import type {
  GatewayEvent,
  ResolvedProvider,
  TokenUsage,
  UpstreamFailure,
} from "../gateway/types.js";
import { closeUpstreamDispatcher } from "../gateway/upstream.js";
import type { UsageSummary } from "../gateway/usage.js";
import { appendHistory, type HistoryRecord, type TargetDescription } from "./history.js";
import type { ScanPlan } from "./plan.js";
import {
  breachesPolicy,
  countSeverities,
  type FindingSummary,
  type SeverityCounts,
  summarizeFindings,
} from "./results.js";

export const GATEWAY_TOKEN_ENV = "KONGYO_SCAN_GATEWAY_TOKEN";
export const GATEWAY_PROVIDER_ID = "kongyo-scan";

export type ScanPhase =
  | "preflight"
  | "threat_model"
  | "discovery"
  | "attack_path"
  | "validation"
  | "reporting";

export type ScanEvent =
  | { type: "stage"; stage: "preparing" | "starting" | "scanning" | "finishing" }
  | { type: "registered"; scanId: string; scanDir: string }
  | {
      type: "progress";
      phase: ScanPhase;
      filesCompleted: number;
      filesTotal: number;
      reviewItems: { completed: number; total: number } | undefined;
    }
  | {
      type: "deep_progress";
      completed: number;
      active: number;
      maximum: number;
      consolidating: boolean;
    }
  | {
      type: "activity";
      id: string;
      kind: "command" | "tool" | "reasoning" | "message";
      status: "running" | "completed" | "failed";
      description: string;
      worker: number | undefined;
    }
  | { type: "usage"; usage: UsageSummary }
  | { type: "provider"; provider: string; model: string }
  | { type: "fallback"; from: string; to: string; reason: string }
  | { type: "provider_failure"; failure: UpstreamFailure }
  | { type: "reconnect"; attempt: number; maxAttempts: number; reason: string | undefined }
  | { type: "warning"; message: string };

export interface ScanOutcome {
  scanId: string;
  status: string;
  repository: string;
  target: TargetDescription;
  mode: string;
  scanDir: string;
  reportPath: string;
  findingsPath: string;
  sarifPath: string | null;
  threatModelPath: string | null;
  findings: FindingSummary[];
  counts: SeverityCounts;
  policy: { failOnSeverity: string | undefined; breached: boolean };
  usage: UsageSummary;
  providers: string[];
  model: string;
  effort: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: ScanEvent) => void;
  onGatewayEvent?: (event: GatewayEvent) => void;
}

type Env = Record<string, string | undefined>;

async function withEnvironment<T>(changes: Env, task: () => Promise<T>): Promise<T> {
  const previous: Env = {};
  for (const [name, value] of Object.entries(changes)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await task();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function noProxyWithLoopback(current: string | undefined): string {
  const entries = (current ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const host of ["127.0.0.1", "localhost"]) {
    if (!entries.includes(host)) entries.push(host);
  }
  return entries.join(",");
}

async function scanEnvironment(plan: ScanPlan, paths: AppPaths, token: string): Promise<Env> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  const environment: Env = {
    CODEX_SECURITY_STATE_DIR: paths.stateDir,
    CODEX_HOME: paths.codexHome,
    CODEX_SECURITY_NO_UPDATE_NOTICE: "1",
    CODEX_SECURITY_PROJECT_CONFIG: undefined,
    OPENAI_API_KEY: undefined,
    CODEX_API_KEY: undefined,
    [GATEWAY_TOKEN_ENV]: token,
    NO_PROXY: noProxyWithLoopback(process.env["NO_PROXY"] ?? process.env["no_proxy"]),
    no_proxy: noProxyWithLoopback(process.env["no_proxy"] ?? process.env["NO_PROXY"]),
  };
  for (const provider of plan.chain) {
    const match = /^environment variable (.+)$/u.exec(provider.apiKeySource ?? "");
    if (match) environment[match[1]!] = undefined;
  }
  return environment;
}

function gatewayProviders(plan: ScanPlan): ResolvedProvider[] {
  if (plan.effort !== EFFORT_PROVIDER_DEFAULT) return plan.chain;
  return plan.chain.map((provider) =>
    provider.reasoningEffort === undefined
      ? { ...provider, reasoningEffort: EFFORT_PROVIDER_DEFAULT }
      : provider,
  );
}

function codexOverrides(plan: ScanPlan, baseUrl: string): JsonObject {
  const firstByteBudget = plan.chain.reduce(
    (total, provider) => total + provider.firstByteTimeoutMs,
    0,
  );
  const overrides: JsonObject = {
    ...plan.codex,
    model: plan.chain[0]!.model,
    model_reasoning_effort: plan.effort === EFFORT_PROVIDER_DEFAULT ? "medium" : plan.effort,
    model_provider: GATEWAY_PROVIDER_ID,
    model_providers: {
      [GATEWAY_PROVIDER_ID]: {
        name: "kongyo-scan",
        base_url: baseUrl,
        env_key: GATEWAY_TOKEN_ENV,
        wire_api: "responses",
        request_max_retries: plan.gateway.maxRequestRetries,
        stream_idle_timeout_ms: firstByteBudget + plan.gateway.idleTimeoutMs + 30_000,
      },
    },
  };
  const windows = plan.chain.map((provider) => provider.contextWindow);
  if (
    overrides["model_context_window"] === undefined &&
    windows.every((window) => window !== undefined)
  ) {
    overrides["model_context_window"] = Math.min(...(windows as number[]));
  }
  return overrides;
}

type Sdk = typeof import("@openai/codex-security");

function sdkTarget(sdk: Sdk, target: TargetDescription): NonNullable<ScanOptions["target"]> {
  switch (target.kind) {
    case "paths":
      return [...(target.paths ?? [])];
    case "diff":
      return sdk.DiffTarget.refs({
        base: target.base ?? "HEAD",
        ...(target.head ? { head: target.head } : {}),
      });
    case "working_tree":
      return sdk.DiffTarget.workingTree(target.base ? { base: target.base } : {});
    default:
      return "repository";
  }
}

function baseScanOptions(sdk: Sdk, plan: ScanPlan): ScanOptions {
  const options: ScanOptions = {
    auth: "api-key",
    mode: plan.mode,
    target: sdkTarget(sdk, plan.target),
    ownerSuggestions: plan.ownerSuggestions,
    archiveExisting: plan.archiveExisting,
  };
  if (plan.maxTimeMinutes !== undefined) options.maxTimeMinutes = plan.maxTimeMinutes;
  if (plan.knowledgeBase.length > 0) options.knowledgeBasePaths = plan.knowledgeBase;
  if (plan.scanPromptFile !== undefined) options.scanPromptFile = plan.scanPromptFile;
  if (plan.validationPromptFile !== undefined)
    options.validationPromptFile = plan.validationPromptFile;
  if (plan.postScanPromptFile !== undefined) options.postScanPromptFile = plan.postScanPromptFile;
  if (plan.rubricFile !== undefined) options.rubricPath = plan.rubricFile;
  if (plan.outputDir !== undefined) options.outputDir = plan.outputDir;
  if (plan.failOnSeverity !== undefined) options.failureSeverity = plan.failOnSeverity;
  if (plan.mode === "deep") {
    if (plan.deep.workers !== undefined) options.workers = plan.deep.workers;
    if (plan.deep.subagents !== undefined) options.subagents = plan.deep.subagents;
    if (plan.deep.stopAfterNoNew !== undefined) options.stopAfterNoNew = plan.deep.stopAfterNoNew;
    if (plan.deep.stopAfterConsecutiveErrors !== undefined) {
      options.stopAfterConsecutiveErrors = plan.deep.stopAfterConsecutiveErrors;
    }
    if (plan.deep.maxDiscoveryRuns !== undefined)
      options.maxDiscoveryRuns = plan.deep.maxDiscoveryRuns;
  }
  return options;
}

export interface PreflightSummary {
  repository: string;
  target: TargetDescription;
  mode: string;
  effort: string;
  providers: {
    name: string;
    model: string;
    wireApi: string;
    baseUrl: string;
    keySource: string | null;
  }[];
  stateDirectory: string;
  outputDir: string | null;
  maxTimeMinutes: number | null;
  maxCostUsd: number | null;
  failOnSeverity: string | null;
}

export async function preflightScan(plan: ScanPlan, paths: AppPaths): Promise<PreflightSummary> {
  const sdk = await import("@openai/codex-security");
  const environment = await scanEnvironment(plan, paths, "preflight");
  return await withEnvironment(environment, async () => {
    const security = new sdk.CodexSecurity({
      codexOverrides: codexOverrides(plan, "http://127.0.0.1:9/v1"),
      ...(plan.python !== undefined ? { pythonPath: plan.python } : {}),
    });
    try {
      const preflight = await security.preflight(plan.repository, baseScanOptions(sdk, plan));
      return {
        repository: preflight.repository,
        target: plan.target,
        mode: preflight.mode,
        effort: plan.effort,
        providers: plan.chain.map((provider) => ({
          name: provider.name,
          model: provider.model,
          wireApi: provider.wireApi,
          baseUrl: provider.baseUrl,
          keySource: provider.apiKeySource ?? null,
        })),
        stateDirectory: preflight.stateDirectory ?? paths.stateDir,
        outputDir: preflight.outputDir,
        maxTimeMinutes: plan.maxTimeMinutes ?? null,
        maxCostUsd: plan.maxCostUsd ?? null,
        failOnSeverity: plan.failOnSeverity ?? null,
      };
    } catch (error) {
      throw translateSdkError(sdk, error, {
        plan,
        failures: [],
        scanId: undefined,
        scanDir: undefined,
        canceled: false,
        costLimited: false,
      });
    } finally {
      await security.close().catch(() => undefined);
    }
  });
}

interface FailureContext {
  plan: ScanPlan;
  failures: readonly UpstreamFailure[];
  scanId: string | undefined;
  scanDir: string | undefined;
  canceled: boolean;
  costLimited: boolean;
}

export async function runScan(
  plan: ScanPlan,
  paths: AppPaths,
  options: RunOptions = {},
): Promise<ScanOutcome> {
  const emit = options.onEvent ?? (() => undefined);
  const startedAt = new Date();
  emit({ type: "stage", stage: "preparing" });

  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  let gateway: Gateway | undefined;
  let lastProvider: string | undefined;
  let exhausted: UpstreamFailure[] = [];
  let costLimited = false;
  const used: string[] = [];
  let registered: { scanId: string; scanDir: string } | undefined;
  const observer = (event: GatewayEvent): void => {
    options.onGatewayEvent?.(event);
    if (event.type === "completed") {
      exhausted = [];
      if (!used.includes(event.provider)) used.push(event.provider);
      if (event.provider !== lastProvider) {
        lastProvider = event.provider;
        emit({ type: "provider", provider: event.provider, model: event.model });
      }
      if (gateway) {
        const usage = gateway.usage();
        emit({ type: "usage", usage });
        if (
          plan.maxCostUsd !== undefined &&
          usage.costUsd !== null &&
          usage.costUsd > plan.maxCostUsd &&
          !costLimited
        ) {
          costLimited = true;
          controller.abort(new Error("cost limit"));
        }
      }
    } else if (event.type === "fallback") {
      emit({ type: "fallback", from: event.from, to: event.to, reason: event.failure.message });
    } else if (event.type === "failure") {
      emit({ type: "provider_failure", failure: event.failure });
    } else if (event.type === "exhausted") {
      exhausted = event.failures;
    }
  };

  const sdk = await import("@openai/codex-security");
  let security: InstanceType<Sdk["CodexSecurity"]> | undefined;
  const history = async (record: HistoryRecord): Promise<void> => {
    await appendHistory(paths.historyFile, record).catch(() => undefined);
  };
  const baseRecord = (): Omit<HistoryRecord, "status" | "scanId" | "scanDir"> => ({
    repository: plan.repository,
    target: plan.target,
    mode: plan.mode,
    startedAt: startedAt.toISOString(),
    providers:
      used.length > 0 ? [...used] : plan.chain.slice(0, 1).map((provider) => provider.name),
    model: plan.chain[0]!.model,
    effort: plan.effort,
  });

  let pendingScanId: string | undefined;
  let pendingScanDir: string | undefined;
  const register = (): void => {
    if (registered || pendingScanId === undefined || pendingScanDir === undefined) return;
    registered = { scanId: pendingScanId, scanDir: pendingScanDir };
    emit({ type: "registered", ...registered });
    void history({ ...baseRecord(), ...registered, status: "running", pid: process.pid });
  };

  try {
    gateway = await startGateway({
      providers: gatewayProviders(plan),
      port: plan.gateway.port,
      cooldownMs: plan.gateway.cooldownMs,
      idleTimeoutMs: plan.gateway.idleTimeoutMs,
      observer,
    });
    const activeGateway = gateway;
    const environment = await scanEnvironment(plan, paths, activeGateway.token);

    const result: ScanResult = await withEnvironment(environment, async () => {
      security = new sdk.CodexSecurity({
        codexOverrides: codexOverrides(plan, activeGateway.baseUrl),
        ...(plan.python !== undefined ? { pythonPath: plan.python } : {}),
      });
      emit({ type: "stage", stage: "starting" });
      return await security.run(plan.repository, {
        ...baseScanOptions(sdk, plan),
        signal: controller.signal,
        onOutputDirReady: (scanDir) => {
          pendingScanDir = scanDir;
          register();
        },
        onLifecycle: (scan) => {
          pendingScanId = scan.scanId;
          register();
        },
        onScanStarted: () => emit({ type: "stage", stage: "scanning" }),
        onProgress: (progress) =>
          emit({
            type: "progress",
            phase: progress.phase,
            filesCompleted: progress.filesCompleted,
            filesTotal: progress.filesTotal,
            reviewItems: progress.reviewItems,
          }),
        onDeepProgress: (progress) =>
          emit({
            type: "deep_progress",
            completed: progress.completed,
            active: progress.active,
            maximum: progress.maximum,
            consolidating: progress.consolidating === true,
          }),
        onActivity: (activity) =>
          emit({
            type: "activity",
            id: activity.id,
            kind: activity.kind,
            status: activity.status,
            description: sanitizeLine(activity.description),
            worker: activity.worker,
          }),
        onReconnect: (attempt, maxAttempts, details) =>
          emit({ type: "reconnect", attempt, maxAttempts, reason: details?.reason }),
        onWarning: (message) => emit({ type: "warning", message: sanitizeLine(message) }),
        onObserverError: () => undefined,
      });
    });

    emit({ type: "stage", stage: "finishing" });
    const finishedAt = new Date();
    const findings = summarizeFindings(result.findings);
    const counts = countSeverities(findings);
    const usage = activeGateway.usage();
    const outcome: ScanOutcome = {
      scanId: result.manifest.scan.id,
      status: String(result.manifest.scan.status),
      repository: plan.repository,
      target: plan.target,
      mode: plan.mode,
      scanDir: result.scanDir,
      reportPath: result.reportPath,
      findingsPath: result.findingsPath,
      sarifPath: result.sarifPath,
      threatModelPath: result.threatModelPath,
      findings,
      counts,
      policy: {
        failOnSeverity: plan.failOnSeverity,
        breached: breachesPolicy(findings, plan.failOnSeverity),
      },
      usage,
      providers: used,
      model: plan.chain[0]!.model,
      effort: plan.effort,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    await history({
      ...baseRecord(),
      scanId: outcome.scanId,
      scanDir: outcome.scanDir,
      status: "completed",
      finishedAt: outcome.finishedAt,
      reportPath: outcome.reportPath,
      sarifPath: outcome.sarifPath,
      threatModelPath: outcome.threatModelPath,
      findings: counts,
      findingCount: findings.length,
      usage: usage.total,
      costUsd: usage.costUsd,
      durationMs: outcome.durationMs,
    });
    return outcome;
  } catch (error) {
    const canceled = controller.signal.aborted && !costLimited;
    const translated = translateSdkError(sdk, error, {
      plan,
      failures: exhausted,
      scanId: registered?.scanId,
      scanDir: registered?.scanDir,
      canceled,
      costLimited,
    });
    if (registered) {
      const usage: TokenUsage | undefined = gateway?.usage().total;
      await history({
        ...baseRecord(),
        ...registered,
        status: canceled ? "canceled" : "failed",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ...(usage ? { usage } : {}),
        costUsd: gateway?.usage().costUsd ?? null,
        error: translated instanceof CliError ? translated.message : "Canceled.",
      });
    }
    throw translated;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    await security?.close().catch(() => undefined);
    await gateway?.close().catch(() => undefined);
    await closeUpstreamDispatcher();
  }
}

const PROVIDER_CHECK_STEP = {
  label: "Check the providers",
  argv: ["kongyo-scan", "providers", "check"],
};

function translateSdkError(
  sdk: Sdk,
  error: unknown,
  context: FailureContext,
): CliError | CanceledError {
  if (error instanceof CliError || error instanceof CanceledError) return error;
  const idRows: [string, string][] = [];
  if (context.scanId) idRows.push(["Scan ID", context.scanId]);
  if (context.scanDir) idRows.push(["Results", context.scanDir]);

  if (context.costLimited) {
    return new CliError(
      "limit",
      `Stopped the scan. Its estimated cost passed the limit of $${context.plan.maxCostUsd?.toFixed(2)}.`,
      {
        reason: "quota_exceeded",
        rows: idRows,
        hint: "Raise --max-cost or narrow the scan with --path. Findings from a stopped scan are incomplete.",
      },
    );
  }
  if (context.canceled || error instanceof sdk.ScanInterruptedError) {
    return new CanceledError(
      context.scanId
        ? `Scan ${context.scanId} was stopped before it finished; no report was written.`
        : "No scan was started.",
    );
  }

  const message = describeError(error);
  if (context.failures.length > 0) {
    const failure = representativeFailure(context.failures)!;
    const rows: [string, string][] = context.failures
      .slice(0, 5)
      .map((item) => [item.provider, item.message]);
    const errorClass =
      failure.kind === "auth"
        ? "auth"
        : failure.kind === "quota" || failure.kind === "rate_limit"
          ? "limit"
          : failure.kind === "network" || failure.kind === "timeout"
            ? "network"
            : "platform";
    const cause =
      failure.kind === "auth"
        ? "The provider rejected the API key."
        : failure.kind === "quota"
          ? "The provider reports that the quota is used up."
          : failure.kind === "rate_limit"
            ? "The provider kept rate limiting requests."
            : failure.kind === "not_found"
              ? "The provider doesn't know the model or endpoint."
              : failure.kind === "network" || failure.kind === "timeout"
                ? "The provider couldn't be reached."
                : "Every provider failed.";
    return new CliError(errorClass, `Scan failed. ${cause}`, {
      reason: context.failures.length > 1 ? "all_providers_failed" : "provider_error",
      rows: [...rows, ...idRows],
      next: [PROVIDER_CHECK_STEP],
      data: { failures: context.failures },
      cause: error,
    });
  }
  if (error instanceof sdk.PluginPythonUnavailableError) {
    return new CliError("platform", "Can't start the scan. Python 3.10 or newer wasn't found.", {
      reason: "unsupported_runtime",
      details: [message],
      hint: "Install Python 3.10+, or point to an interpreter with --python or the python setting.",
      next: [{ label: "Check the environment", argv: ["kongyo-scan", "doctor"] }],
      cause: error,
    });
  }
  if (error instanceof sdk.SandboxUnavailableError) {
    return new CliError(
      "platform",
      "Can't start the scan. The command sandbox isn't available on this machine.",
      {
        reason: "unsupported_runtime",
        details: [message],
        next: [{ label: "Check the environment", argv: ["kongyo-scan", "doctor"] }],
        cause: error,
      },
    );
  }
  if (error instanceof sdk.InvalidTargetError) {
    return new CliError("usage", `Can't scan this target. ${message}`, {
      reason: "invalid_arguments",
      cause: error,
    });
  }
  if (
    error instanceof sdk.OutputDirectoryNotEmptyError ||
    error instanceof sdk.OutputInsideProtectedRootError ||
    error instanceof sdk.OutputDirectoryError
  ) {
    return new CliError("conflict", `Can't use the output directory. ${message}`, {
      reason: "conflict",
      hint: "Choose an empty directory outside the scanned repository, or pass --archive-existing.",
      cause: error,
    });
  }
  if (error instanceof sdk.ConfigurationError) {
    return new CliError("config", `Can't start the scan. ${message}`, {
      reason: "invalid_config",
      cause: error,
    });
  }
  return new CliError("platform", `Scan failed. ${message}`, {
    reason: "scan_failed",
    rows: idRows,
    next: [PROVIDER_CHECK_STEP],
    cause: error,
  });
}
