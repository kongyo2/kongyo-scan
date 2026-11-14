import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";

import type { AppContext } from "../app/context.js";
import { loadKeys, loadUserConfig } from "../app/context.js";
import type { CommandSpec, ParsedArgs } from "../cli/args.js";
import { DEFAULT_REASONING_EFFORT, EFFORT_PROVIDER_DEFAULT } from "../config/schema.js";
import { CliError, usageError } from "../core/errors.js";
import { type Gateway, startGateway } from "../gateway/server.js";
import { closeUpstreamDispatcher } from "../gateway/upstream.js";
import { buildChain } from "../providers/resolve.js";
import { anchorConfigPaths } from "../scan/plan.js";
import { GATEWAY_PROVIDER_ID, GATEWAY_TOKEN_ENV } from "../scan/runner.js";
import { BIN } from "../version.js";

const MODEL_COMMANDS = new Set([
  "scan",
  "validate",
  "patch",
  "verify-fix",
  "policy",
  "bulk-scan",
  "scan-components",
]);

const UNSUPPORTED: Record<string, string> = {
  login: "kongyo-scan uses your configured providers and never signs in to OpenAI.",
  logout: "kongyo-scan uses your configured providers and never signs in to OpenAI.",
  publish: "kongyo-scan keeps findings on this machine.",
  feedback: "kongyo-scan keeps scan data on this machine.",
  update: `Update ${BIN} itself: npm install --global @kongyo2/kongyo-scan@latest`,
};

export function codexSecurityBin(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@openai/codex-security");
  return join(dirname(entry), "..", "bin", "codex-security.mjs");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function gatewayArguments(
  rest: readonly string[],
  settings: { model: string; effort: string; baseUrl: string },
): string[] {
  const has = (flag: string): boolean =>
    rest.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
  if (has("--provider") || rest.some((argument) => /model_provider/u.test(argument))) return [];
  const extra: string[] = [];
  if (!has("--model")) extra.push("--model", settings.model);
  if (!has("--effort")) extra.push("--effort", settings.effort);
  const provider = `model_providers.${GATEWAY_PROVIDER_ID}`;
  extra.push(
    "--codex",
    `model_provider=${tomlString(GATEWAY_PROVIDER_ID)}`,
    "--codex",
    `${provider}.name=${tomlString(BIN)}`,
    "--codex",
    `${provider}.base_url=${tomlString(settings.baseUrl)}`,
    "--codex",
    `${provider}.env_key=${tomlString(GATEWAY_TOKEN_ENV)}`,
    "--codex",
    `${provider}.wire_api="responses"`,
  );
  return extra;
}

const CHILD_STOP_TIMEOUT_MS = 10_000;

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

/**
 * Runs a child with inherited streams and resolves with the exit code to report. When this
 * process is told to stop, the child is told too, and is ended for good if it lingers.
 */
export function runChild(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  context: Pick<AppContext, "signal" | "abortSignalName">,
  stopTimeoutMs = CHILD_STOP_TIMEOUT_MS,
): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit", env: environment });
    let lingering: NodeJS.Timeout | undefined;
    const endNow = (): void => void child.kill("SIGKILL");
    const stop = (): void => {
      // The child handles SIGINT and SIGTERM; a hangup reaches it as a request to terminate.
      child.kill(context.abortSignalName() === "SIGINT" ? "SIGINT" : "SIGTERM");
      lingering = setTimeout(endNow, stopTimeoutMs);
    };
    const settle = (): void => {
      clearTimeout(lingering);
      context.signal.removeEventListener("abort", stop);
      process.off("exit", endNow);
    };
    process.once("exit", endNow);
    if (context.signal.aborted) stop();
    else context.signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      settle();
      reject(
        new CliError("platform", `Failed to start codex-security. ${error.message}`, {
          reason: "spawn_failed",
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      settle();
      const interrupted = context.signal.aborted ? context.abortSignalName() : undefined;
      if (interrupted !== undefined) resolvePromise(signalExitCode(interrupted));
      else if (signal !== null) resolvePromise(signalExitCode(signal));
      else resolvePromise(code ?? 1);
    });
  });
}

async function passthrough(context: AppContext, args: ParsedArgs): Promise<number> {
  const rest = [...args.rest];
  const subcommand = rest.find((argument) => !argument.startsWith("-"));
  if (subcommand !== undefined && UNSUPPORTED[subcommand] !== undefined) {
    throw usageError(
      `Can't run codex-security ${subcommand} through ${BIN}. ${UNSUPPORTED[subcommand]}`,
    );
  }

  const config = anchorConfigPaths(
    await loadUserConfig(context),
    context.paths.configFile,
    context.env,
  );
  const chain = buildChain(config, {}, context.env, await loadKeys(context));
  await mkdir(context.paths.stateDir, { recursive: true, mode: 0o700 });
  await mkdir(context.paths.codexHome, { recursive: true, mode: 0o700 });

  const environment: NodeJS.ProcessEnv = {
    ...context.env,
    CODEX_SECURITY_STATE_DIR: context.paths.stateDir,
    CODEX_HOME: context.paths.codexHome,
    CODEX_SECURITY_NO_UPDATE_NOTICE: "1",
  };
  delete environment["OPENAI_API_KEY"];
  delete environment["CODEX_API_KEY"];
  delete environment["CODEX_SECURITY_PROJECT_CONFIG"];

  let gateway: Gateway | undefined;
  let childArguments = rest;
  try {
    if (chain.length > 0 && subcommand !== undefined) {
      const effort = config.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
      gateway = await startGateway({
        providers:
          effort === EFFORT_PROVIDER_DEFAULT
            ? chain.map((provider) =>
                provider.reasoningEffort === undefined
                  ? { ...provider, reasoningEffort: EFFORT_PROVIDER_DEFAULT }
                  : provider,
              )
            : chain,
        port: config.gateway?.port ?? 0,
        cooldownMs: (config.gateway?.cooldown_seconds ?? 60) * 1000,
        idleTimeoutMs: (config.gateway?.stream_idle_timeout_seconds ?? 300) * 1000,
      });
      environment[GATEWAY_TOKEN_ENV] = gateway.token;
      for (const provider of chain) {
        const match = /^environment variable (.+)$/u.exec(provider.apiKeySource ?? "");
        if (match) delete environment[match[1]!];
      }
      const codexEffort = effort === EFFORT_PROVIDER_DEFAULT ? "medium" : effort;
      await writeFile(
        join(context.paths.codexHome, "config.toml"),
        [
          `model = ${tomlString(chain[0]!.model)}`,
          `model_reasoning_effort = ${tomlString(codexEffort)}`,
          `model_provider = ${tomlString(GATEWAY_PROVIDER_ID)}`,
          "",
          `[model_providers.${GATEWAY_PROVIDER_ID}]`,
          `name = ${tomlString(BIN)}`,
          `base_url = ${tomlString(gateway.baseUrl)}`,
          `env_key = ${tomlString(GATEWAY_TOKEN_ENV)}`,
          `wire_api = "responses"`,
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 },
      );
      if (MODEL_COMMANDS.has(subcommand)) {
        childArguments = [
          ...rest,
          ...gatewayArguments(rest, {
            model: chain[0]!.model,
            effort: codexEffort,
            baseUrl: gateway.baseUrl,
          }),
        ];
      }
    }

    return await runChild(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", codexSecurityBin(), ...childArguments],
      environment,
      context,
    );
  } finally {
    await gateway?.close().catch(() => undefined);
    await closeUpstreamDispatcher();
  }
}

export const passthroughCommand: CommandSpec<AppContext> = {
  name: "codex-security",
  aliases: ["cs"],
  group: "Advanced",
  summary: "Run the bundled Codex Security CLI with your providers and scan state",
  passthrough: true,
  examples: [
    { label: "Draft a SECURITY.md policy", argv: [BIN, "codex-security", "--", "policy", "."] },
    {
      label: "Patch one finding from a saved scan",
      argv: [BIN, "codex-security", "--", "patch", "<OCCURRENCE_ID>"],
    },
    { label: "See every Codex Security command", argv: [BIN, "codex-security", "--", "--help"] },
  ],
  notes: [
    "Everything after the command name goes to codex-security unchanged; its streams and exit code are passed through.",
    "Model requests go through the local gateway and your provider chain. login, logout, publish, feedback, and update are not available.",
  ],
  run: passthrough,
};
