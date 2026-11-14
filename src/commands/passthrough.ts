import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

/** Subcommands that call a model and accept `--model`, `--effort`, and `--codex`. */
const MODEL_COMMANDS = new Set([
  "scan",
  "validate",
  "patch",
  "verify-fix",
  "policy",
  "bulk-scan",
  "scan-components",
]);

/** Subcommands that sign in to OpenAI or send data off this machine; kongyo-scan is local-only. */
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

/** Arguments that route a model-calling subcommand through the gateway. */
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
      // Commands without --codex read the provider from this private Codex home instead.
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

    return await new Promise<number>((resolvePromise, reject) => {
      // Codex Security uses Node's bundled SQLite; its experimental notice is noise here.
      const nodeArguments = ["--disable-warning=ExperimentalWarning", codexSecurityBin()];
      const child = spawn(process.execPath, [...nodeArguments, ...childArguments], {
        stdio: "inherit",
        env: environment,
      });
      child.once("error", (error) => {
        reject(
          new CliError("platform", `Failed to start codex-security. ${error.message}`, {
            reason: "spawn_failed",
            cause: error,
          }),
        );
      });
      child.once("exit", (code, signal) => {
        if (signal === "SIGINT") resolvePromise(130);
        else if (signal === "SIGTERM") resolvePromise(143);
        else if (signal === "SIGHUP") resolvePromise(129);
        else resolvePromise(code ?? 1);
      });
    });
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
