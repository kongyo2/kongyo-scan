import type { AppContext } from "../app/context.js";
import { loadKeys, loadUserConfig } from "../app/context.js";
import {
  booleanOption,
  type CommandSpec,
  listOption,
  numberOption,
  type ParsedArgs,
  requireArgument,
  stringOption,
} from "../cli/args.js";
import { formatDuration } from "../cli/format.js";
import {
  deleteProviderKey,
  renameProviderKey,
  setProviderKey,
  type StoredKeys,
} from "../config/credentials.js";
import { maskSecret } from "../config/keys.js";
import { CUSTOM_PRESET_ID, findPreset, PROVIDER_PRESETS } from "../config/presets.js";
import {
  type Config,
  DEFAULT_REASONING_EFFORT,
  type ProviderConfig,
  PROVIDER_NAME_PATTERN,
  WIRE_APIS,
  type WireApi,
} from "../config/schema.js";
import { updateConfigFile } from "../config/store.js";
import { CliError, usageError } from "../core/errors.js";
import { type CheckResult, checkProvider, detectWireApi, listModels } from "../providers/check.js";
import { availableProviders, ENV_PROVIDER_NAME, resolveProvider } from "../providers/resolve.js";
import { BIN } from "../version.js";

function findIndex(config: Config, name: string): number {
  const index = (config.providers ?? []).findIndex(
    (provider) => provider.name.toLowerCase() === name.toLowerCase(),
  );
  if (index < 0) {
    const names = (config.providers ?? []).map((provider) => provider.name);
    throw new CliError("not_found", `Couldn't find provider ${JSON.stringify(name)}.`, {
      reason: "provider_not_found",
      data: { providers: names },
      next: [{ label: "List configured providers", argv: [BIN, "providers", "list"] }],
    });
  }
  return index;
}

type KeySource = "environment" | "stored" | "settings" | "none";

function keySource(provider: ProviderConfig, env: NodeJS.ProcessEnv, keys: StoredKeys): KeySource {
  if (provider.api_key_env !== undefined && (env[provider.api_key_env] ?? "").trim() !== "")
    return "environment";
  if (keys[provider.name.toLowerCase()] !== undefined) return "stored";
  return provider.api_key !== undefined ? "settings" : "none";
}

export function keyLabel(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv,
  keys: StoredKeys,
): string {
  switch (keySource(provider, env, keys)) {
    case "environment":
      return `$${provider.api_key_env}`;
    case "stored":
      return `stored ${maskSecret(keys[provider.name.toLowerCase()] ?? "")}`;
    case "settings":
      return "in the settings file (unprotected)";
    default:
      return provider.api_key_env !== undefined ? `$${provider.api_key_env} (unset)` : "none";
  }
}

export function providerDocument(
  provider: ProviderConfig,
  position: number,
  env: NodeJS.ProcessEnv,
  keys: StoredKeys,
): Record<string, unknown> {
  return {
    name: provider.name,
    position,
    baseUrl: provider.base_url,
    model: provider.model,
    wireApi: provider.wire_api ?? "chat",
    enabled: provider.disabled !== true,
    key: { source: keySource(provider, env, keys), env: provider.api_key_env ?? null },
    reasoningEffort: provider.reasoning_effort ?? null,
    headers: Object.keys(provider.headers ?? {}),
  };
}

async function listProviders(context: AppContext): Promise<number> {
  const { output, terminal, env } = context;
  const config = await loadUserConfig(context);
  const keys = await loadKeys(context);
  const providers = availableProviders(config, env);
  if (terminal.json) {
    output.json({
      providers: providers.map((provider, index) =>
        providerDocument(provider, index + 1, env, keys),
      ),
      pagination: { next: null },
    });
    return 0;
  }
  if (providers.length === 0) {
    if (!output.out.rich)
      output.table(
        [
          { header: "#" },
          { header: "Name" },
          { header: "Model" },
          { header: "API" },
          { header: "Key" },
          { header: "Status" },
        ],
        [],
      );
    output.info("  No providers configured.");
    output.next([{ label: "Add one", argv: [BIN, "providers", "add"] }]);
    return 0;
  }
  output.table(
    [
      { header: "#" },
      { header: "Name" },
      { header: "Model" },
      { header: "API" },
      { header: "Key" },
      { header: "Status" },
    ],
    providers.map((provider, index) => [
      String(index + 1),
      provider.name,
      provider.model,
      provider.wire_api ?? "chat",
      keyLabel(provider, env, keys),
      provider.disabled
        ? "disabled"
        : index === providers.findIndex((item) => !item.disabled)
          ? "primary"
          : "fallback",
    ]),
  );
  return 0;
}

async function readSecretFromStdin(option: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw usageError(`Can't read ${option} from a terminal. Pipe the key in.`, {
      next: [
        {
          label: "Pipe the key from an environment variable",
          argv: ["printenv", "<NAME>", "|", BIN, "providers", "add", option],
        },
      ],
    });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/u, "");
  if (text.trim() === "") throw usageError(`Can't use an empty key from ${option}.`);
  return text.trim();
}

function parseHeaders(values: readonly string[] | undefined): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw usageError(`Can't use --header ${value}. Write it as NAME=VALUE.`);
    headers[value.slice(0, separator).trim()] = value.slice(separator + 1);
  }
  return headers;
}

function defaultName(baseUrl: string): string {
  const host = URL.parse(baseUrl)?.hostname ?? "provider";
  const parts = host
    .split(".")
    .filter(
      (part) => !["www", "api", "com", "ai", "io", "net", "org", "dev", "app"].includes(part),
    );
  const name = (parts.at(-1) ?? host).replaceAll(/[^A-Za-z0-9._-]/gu, "-");
  return /^[A-Za-z0-9]/u.test(name) ? name : `provider-${name}`;
}

function describeCheck(result: CheckResult): string {
  if (!result.ok) return `failed: ${result.failure?.message ?? "unknown error"}`;
  return `ok in ${formatDuration(result.latencyMs)}${result.toolCall ? " (tool calling works)" : " (answered, but did not call the probe tool)"}`;
}

function rejectionHint(effort: string | undefined): string {
  return effort === undefined
    ? "The endpoint rejected the test request."
    : `The endpoint rejected the test request. If it does not accept reasoning effort ${effort}, pass --effort with a value it accepts, or --effort default to send none.`;
}

function checkFailedError(name: string, result: CheckResult, effort: string | undefined): CliError {
  const failure = result.failure;
  const errorClass =
    failure?.kind === "auth"
      ? "auth"
      : failure?.kind === "network" || failure?.kind === "timeout"
        ? "network"
        : "platform";
  return new CliError(
    errorClass,
    `Couldn't reach provider ${name}. ${failure?.message ?? "The check failed."}`,
    {
      reason:
        failure?.kind === "auth"
          ? "invalid_credentials"
          : failure?.kind === "network" || failure?.kind === "timeout"
            ? "network_error"
            : "provider_error",
      hint:
        failure?.kind === "bad_request"
          ? `Nothing was saved. ${rejectionHint(effort)}`
          : "Nothing was saved. Fix the endpoint, model, or key, or pass --no-check to save it anyway.",
      data: { failure },
    },
  );
}

interface AddInputs {
  name: string | undefined;
  preset: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  apiKeyEnv: string | undefined;
  hasKey: boolean;
  wireApi: WireApi | undefined;
  headers: Record<string, string> | undefined;
  effort: string | undefined;
  contextWindow: number | undefined;
}

export function buildProvider(inputs: AddInputs, env: NodeJS.ProcessEnv): ProviderConfig {
  const preset =
    inputs.preset === undefined || inputs.preset === CUSTOM_PRESET_ID
      ? undefined
      : findPreset(inputs.preset);
  if (inputs.preset !== undefined && inputs.preset !== CUSTOM_PRESET_ID && !preset) {
    throw usageError(
      `Can't use --preset ${inputs.preset}. Use one of ${PROVIDER_PRESETS.map((item) => item.id).join(", ")}, or ${CUSTOM_PRESET_ID}.`,
    );
  }
  const baseUrl = inputs.baseUrl ?? preset?.base_url;
  const missing: string[] = [];
  if (baseUrl === undefined) missing.push("--base-url");
  if (inputs.model === undefined) missing.push("--model");
  if (baseUrl === undefined || inputs.model === undefined) {
    throw new CliError(
      "missing_input",
      `Can't add a provider without ${missing.join(" and ")} in non-interactive mode.`,
      {
        reason: "missing_input",
        data: { missing, presets: PROVIDER_PRESETS.map((item) => item.id) },
        next: [
          {
            label: "Pass the endpoint and model",
            argv: [
              BIN,
              "providers",
              "add",
              "--base-url",
              "<URL>",
              "--model",
              "<NAME>",
              "--api-key-env",
              "<NAME>",
            ],
          },
        ],
      },
    );
  }
  const name = inputs.name ?? preset?.id ?? defaultName(baseUrl);
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw usageError(
      `Can't use ${JSON.stringify(name)} as a provider name. Names use letters, digits, dots, underscores, and hyphens.`,
    );
  }
  if (name.toLowerCase() === ENV_PROVIDER_NAME) {
    throw usageError(
      `Can't name a provider ${ENV_PROVIDER_NAME}. That name is reserved for the provider defined by KONGYO_SCAN_BASE_URL.`,
    );
  }
  const provider: ProviderConfig = { name, base_url: baseUrl, model: inputs.model };
  const wire = inputs.wireApi ?? preset?.wire_api;
  if (wire !== undefined) provider.wire_api = wire;
  if (inputs.apiKeyEnv !== undefined) provider.api_key_env = inputs.apiKeyEnv;
  else if (!inputs.hasKey && preset?.api_key_env && (env[preset.api_key_env] ?? "").trim() !== "") {
    provider.api_key_env = preset.api_key_env;
  }
  const headers = { ...preset?.headers, ...inputs.headers };
  if (Object.keys(headers).length > 0) provider.headers = headers;
  if (inputs.effort !== undefined) provider.reasoning_effort = inputs.effort;
  if (inputs.contextWindow !== undefined) provider.context_window = inputs.contextWindow;
  return provider;
}

/**
 * The stored keys a provider being added may use. A key already stored under its name belongs
 * to whatever had that name before, possibly another endpoint, so it is never carried over.
 */
export function keysForNewProvider(
  stored: StoredKeys,
  name: string,
  apiKey: string | undefined,
): StoredKeys {
  const { [name.toLowerCase()]: _previous, ...others } = stored;
  return apiKey === undefined ? others : { ...others, [name.toLowerCase()]: apiKey };
}

export async function verifyProvider(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  effort: string | undefined,
  keys: StoredKeys,
): Promise<{ provider: ProviderConfig; result: CheckResult }> {
  const resolved = resolveProvider(provider, env, keys);
  if (provider.wire_api !== undefined) {
    return {
      provider,
      result: await checkProvider(resolved, {
        signal,
        effort: provider.reasoning_effort ?? effort,
      }),
    };
  }
  const detected = await detectWireApi(resolved, {
    signal,
    effort: provider.reasoning_effort ?? effort,
  });
  const chosen = detected.results.find((result) => result.wireApi === detected.wireApi);
  if (detected.wireApi === undefined || !chosen) {
    return {
      provider,
      result: detected.results.find((result) => result.wireApi === "chat") ?? detected.results[0]!,
    };
  }
  return { provider: { ...provider, wire_api: detected.wireApi }, result: chosen };
}

function wireOption(args: ParsedArgs): WireApi | undefined {
  return stringOption(args, "wire-api") as WireApi | undefined;
}

async function addProvider(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal, env } = context;
  const hasInputs =
    stringOption(args, "base-url") !== undefined ||
    stringOption(args, "model") !== undefined ||
    stringOption(args, "preset") !== undefined;
  if (terminal.interactive && !hasInputs && !booleanOption(args, "api-key-stdin")) {
    const { runProviderWizard } = await import("../tui/provider-wizard.js");
    return await runProviderWizard(context, {
      name: args.positionals[0],
      first: booleanOption(args, "first") === true,
    });
  }

  const apiKey = booleanOption(args, "api-key-stdin")
    ? await readSecretFromStdin("--api-key-stdin")
    : undefined;
  if (apiKey !== undefined && stringOption(args, "api-key-env") !== undefined) {
    throw usageError(
      "Can't use --api-key-stdin with --api-key-env. Choose where the key comes from.",
    );
  }
  let provider = buildProvider(
    {
      name: args.positionals[0],
      preset: stringOption(args, "preset"),
      baseUrl: stringOption(args, "base-url"),
      model: stringOption(args, "model"),
      apiKeyEnv: stringOption(args, "api-key-env"),
      hasKey: apiKey !== undefined,
      wireApi: wireOption(args),
      headers: parseHeaders(listOption(args, "header")),
      effort: stringOption(args, "effort"),
      contextWindow: numberOption(args, "context-window"),
    },
    env,
  );

  const existing = await loadUserConfig(context);
  const keys = keysForNewProvider(await loadKeys(context), provider.name, apiKey);
  const taken = (existing.providers ?? []).some(
    (item) => item.name.toLowerCase() === provider.name.toLowerCase(),
  );
  const force = booleanOption(args, "force") === true;
  if (taken && !force) {
    throw new CliError(
      "conflict",
      `Can't add provider ${provider.name}. A provider with that name already exists.`,
      {
        reason: "provider_exists",
        next: [
          {
            label: "Change the existing provider",
            argv: [BIN, "providers", "update", provider.name, "--model", "<NAME>"],
          },
          {
            label: "Replace it",
            argv: [
              BIN,
              "providers",
              "add",
              provider.name,
              "--force",
              "--base-url",
              "<URL>",
              "--model",
              "<NAME>",
            ],
          },
        ],
      },
    );
  }

  let check: CheckResult | undefined;
  if (booleanOption(args, "check") !== false) {
    if (!terminal.json) output.info(`  Checking ${provider.name}${output.err.glyph.ellipsis}`);
    const effort = existing.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    const verified = await verifyProvider(provider, env, context.signal, effort, keys);
    provider = verified.provider;
    check = verified.result;
    if (!check.ok) {
      throw checkFailedError(provider.name, check, provider.reasoning_effort ?? effort);
    }
    if (!check.toolCall) {
      output.warn(
        "tool_calls_unverified",
        `${provider.name} answered but did not call the probe tool. Scans depend on tool calls; try --wire-api chat or another model.`,
      );
    }
  } else if (provider.wire_api === undefined) {
    provider = { ...provider, wire_api: "chat" };
  }

  const first = booleanOption(args, "first") === true;
  const saved = await updateConfigFile(context.paths.configFile, (config) => {
    const providers = (config.providers ?? []).filter(
      (item) => item.name.toLowerCase() !== provider.name.toLowerCase(),
    );
    if (first) providers.unshift(provider);
    else providers.push(provider);
    config.providers = providers;
  });
  if (apiKey !== undefined)
    await setProviderKey(context.paths.credentialsFile, provider.name, apiKey);
  else await deleteProviderKey(context.paths.credentialsFile, provider.name);
  const position = findIndex(saved, provider.name) + 1;
  const outcome = taken ? "replaced" : "added";

  if (terminal.json) {
    output.json(
      {
        provider: providerDocument(provider, position, env, keys),
        outcome,
        ...(check ? { check: checkDocument(check) } : {}),
      },
      [{ label: "Scan a repository", argv: [BIN, "scan"] }],
    );
    return 0;
  }
  output.success(taken ? "Replaced" : "Added", provider.name);
  output.row("Model", provider.model);
  output.row("API", provider.wire_api ?? "chat");
  output.row("Base URL", provider.base_url);
  output.row("Key", keyLabel(provider, env, keys));
  output.row("Position", `${position} of ${saved.providers?.length ?? 1}`);
  if (check) output.row("Check", describeCheck(check));
  if (!terminal.stdout.isTTY) output.line(provider.name);
  output.next([{ label: "Scan a repository", argv: [BIN, "scan"] }]);
  return 0;
}

function checkDocument(result: CheckResult): Record<string, unknown> {
  return {
    provider: result.provider,
    model: result.model,
    wireApi: result.wireApi,
    ok: result.ok,
    toolCall: result.toolCall,
    reasoning: result.reasoning,
    latencyMs: result.latencyMs,
    ...(result.failure
      ? {
          error: {
            kind: result.failure.kind,
            status: result.failure.status ?? null,
            message: result.failure.message,
          },
        }
      : {}),
  };
}

async function updateProvider(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal, env } = context;
  const name = requireArgument(args, 0, "provider", `${BIN} providers update`);
  const apiKey = booleanOption(args, "api-key-stdin")
    ? await readSecretFromStdin("--api-key-stdin")
    : undefined;
  const headers = parseHeaders(listOption(args, "header"));
  const changes: Partial<ProviderConfig> = {};
  const model = stringOption(args, "model");
  const baseUrl = stringOption(args, "base-url");
  const apiKeyEnv = stringOption(args, "api-key-env");
  const effort = stringOption(args, "effort");
  const wire = wireOption(args);
  const contextWindow = numberOption(args, "context-window");
  const rename = stringOption(args, "name");
  if (model !== undefined) changes.model = model;
  if (baseUrl !== undefined) changes.base_url = baseUrl;
  if (apiKey !== undefined && apiKeyEnv !== undefined) {
    throw usageError(
      "Can't use --api-key-stdin with --api-key-env. Choose where the key comes from.",
    );
  }
  if (apiKeyEnv !== undefined) changes.api_key_env = apiKeyEnv;
  if (wire !== undefined) changes.wire_api = wire;
  if (effort !== undefined) changes.reasoning_effort = effort;
  if (contextWindow !== undefined) changes.context_window = contextWindow;
  if (rename !== undefined) changes.name = rename;
  if (Object.keys(changes).length === 0 && headers === undefined && apiKey === undefined) {
    throw new CliError("missing_input", `Can't update provider ${name} without a change.`, {
      reason: "missing_input",
      next: [{ label: "See what can be changed", argv: [BIN, "providers", "update", "--help"] }],
    });
  }
  let updated: ProviderConfig | undefined;
  let previousName = name;
  let position = 0;
  await updateConfigFile(context.paths.configFile, (config) => {
    const index = findIndex(config, name);
    const current = config.providers![index]!;
    previousName = current.name;
    const next: ProviderConfig = { ...current, ...changes };
    if (headers !== undefined) next.headers = { ...current.headers, ...headers };
    if (apiKey !== undefined) {
      delete next.api_key_env;
      delete next.api_key;
    }
    if (apiKeyEnv !== undefined) delete next.api_key;
    config.providers![index] = next;
    updated = next;
    position = index + 1;
  });
  const provider = updated!;
  const credentials = context.paths.credentialsFile;
  if (provider.name !== previousName)
    await renameProviderKey(credentials, previousName, provider.name);
  if (apiKey !== undefined) await setProviderKey(credentials, provider.name, apiKey);
  else if (apiKeyEnv !== undefined) await deleteProviderKey(credentials, provider.name);
  const keys = await loadKeys(context);
  if (terminal.json) {
    output.json({ provider: providerDocument(provider, position, env, keys), outcome: "updated" });
    return 0;
  }
  output.success("Updated", provider.name);
  output.row("Model", provider.model);
  output.row("API", provider.wire_api ?? "chat");
  output.row("Base URL", provider.base_url);
  output.row("Key", keyLabel(provider, env, keys));
  if (!terminal.stdout.isTTY) output.line(provider.name);
  return 0;
}

async function removeProvider(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  const name = requireArgument(args, 0, "provider", `${BIN} providers remove`);
  let removed: ProviderConfig | undefined;
  const saved = await updateConfigFile(context.paths.configFile, (config) => {
    const index = findIndex(config, name);
    removed = config.providers![index]!;
    config.providers = config.providers!.filter((_, position) => position !== index);
  });
  const provider = removed!;
  const keyDeleted = await deleteProviderKey(context.paths.credentialsFile, provider.name);
  const remaining = saved.providers?.length ?? 0;
  if (terminal.json) {
    output.json({ provider: { name: provider.name }, outcome: "removed", keyDeleted, remaining }, [
      { label: "List the remaining providers", argv: [BIN, "providers", "list"] },
    ]);
    return 0;
  }
  output.success("Removed", provider.name);
  if (keyDeleted || provider.api_key !== undefined)
    output.row("Key", "the stored API key was deleted with it");
  output.row("Remaining", remaining === 0 ? "No providers" : String(remaining));
  if (!terminal.stdout.isTTY) output.line(provider.name);
  return 0;
}

async function moveProvider(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal, env } = context;
  const name = requireArgument(args, 0, "provider", `${BIN} providers move`);
  const position = numberOption(args, "position");
  const first = booleanOption(args, "first") === true;
  const last = booleanOption(args, "last") === true;
  const given = [position !== undefined, first, last].filter(Boolean).length;
  if (given !== 1) {
    throw usageError(
      given === 0
        ? `Can't move provider ${name} without --position, --first, or --last.`
        : "Can't combine --position, --first, and --last. Choose one.",
      {
        next: [
          {
            label: "Make it the primary provider",
            argv: [BIN, "providers", "move", name, "--first"],
          },
        ],
      },
    );
  }
  let from = 0;
  let to = 0;
  let unchanged = false;
  const saved = await updateConfigFile(context.paths.configFile, (config) => {
    const providers = [...(config.providers ?? [])];
    const index = findIndex(config, name);
    const target = first ? 1 : last ? providers.length : position!;
    if (!Number.isInteger(target) || target < 1 || target > providers.length) {
      throw usageError(
        `Can't move provider ${name} to position ${target}. Positions run from 1 to ${providers.length}.`,
      );
    }
    from = index + 1;
    to = target;
    if (from === to) {
      unchanged = true;
      return;
    }
    const [moved] = providers.splice(index, 1);
    providers.splice(target - 1, 0, moved!);
    config.providers = providers;
  });
  const order = (saved.providers ?? []).map((provider) => provider.name);
  if (terminal.json) {
    output.json({
      provider: providerDocument(saved.providers![to - 1]!, to, env, await loadKeys(context)),
      outcome: unchanged ? "unchanged" : "moved",
      order,
    });
    return 0;
  }
  if (unchanged) output.info(`  ${name} is already at position ${to}.`);
  else {
    output.success("Moved", name);
    output.row("Position", `${from} -> ${to}`);
  }
  output.row("Order", order.join(" -> "));
  if (!terminal.stdout.isTTY) output.line(name);
  return 0;
}

function toggleProvider(
  disabled: boolean,
): (context: AppContext, args: ParsedArgs) => Promise<number> {
  return async (context, args) => {
    const { output, terminal, env } = context;
    const verb = disabled ? "disable" : "enable";
    const name = requireArgument(args, 0, "provider", `${BIN} providers ${verb}`);
    let unchanged = false;
    let position = 0;
    const saved = await updateConfigFile(context.paths.configFile, (config) => {
      const index = findIndex(config, name);
      const current = config.providers![index]!;
      position = index + 1;
      if ((current.disabled === true) === disabled) {
        unchanged = true;
        return;
      }
      const next = { ...current };
      if (disabled) next.disabled = true;
      else delete next.disabled;
      config.providers![index] = next;
    });
    const provider = saved.providers![position - 1]!;
    if (terminal.json) {
      output.json({
        provider: providerDocument(provider, position, env, await loadKeys(context)),
        outcome: unchanged ? "unchanged" : `${verb}d`,
      });
      return 0;
    }
    if (unchanged) output.info(`  ${provider.name} is already ${verb}d.`);
    else output.success(disabled ? "Disabled" : "Enabled", provider.name);
    if (!terminal.stdout.isTTY) output.line(provider.name);
    return 0;
  };
}

async function checkProviders(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal, env } = context;
  const config = await loadUserConfig(context);
  const keys = await loadKeys(context);
  const all = availableProviders(config, env);
  const selected = args.positionals[0];
  const targets =
    selected === undefined
      ? all.filter((provider) => provider.disabled !== true)
      : all.filter((provider) => provider.name.toLowerCase() === selected.toLowerCase());
  if (selected !== undefined && targets.length === 0) findIndex(config, selected);
  if (targets.length === 0) {
    if (terminal.json) output.json({ results: [], summary: { succeeded: 0, failed: 0 } });
    else {
      output.info("  No providers configured.");
      output.next([{ label: "Add one", argv: [BIN, "providers", "add"] }]);
    }
    return 0;
  }
  const effort =
    stringOption(args, "effort") ?? config.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
  if (!terminal.json)
    output.info(
      `  Checking ${targets.length === 1 ? targets[0]!.name : `${targets.length} providers`}${output.err.glyph.ellipsis}`,
    );
  const results = await Promise.all(
    targets.map((provider) =>
      checkProvider(resolveProvider(provider, env, keys), {
        signal: context.signal,
        effort: provider.reasoning_effort ?? effort,
      }),
    ),
  );
  const failed = results.filter((result) => !result.ok).length;
  if (terminal.json) {
    output.json({
      results: results.map(checkDocument),
      summary: { succeeded: results.length - failed, failed },
    });
    return failed > 0 ? 1 : 0;
  }
  output.table(
    [
      { header: "Name" },
      { header: "Model" },
      { header: "API" },
      { header: "Result" },
      { header: "Tools" },
      { header: "Time" },
      { header: "Detail", shrink: true },
    ],
    results.map((result) => [
      result.provider,
      result.model,
      result.wireApi,
      result.ok ? "ok" : "failed",
      result.ok ? (result.toolCall ? "yes" : "no") : "-",
      formatDuration(result.latencyMs),
      result.ok
        ? result.toolCall
          ? ""
          : "answered without calling the probe tool"
        : (result.failure?.message ?? ""),
    ]),
  );
  const untooled = results.filter((result) => result.ok && !result.toolCall);
  for (const result of untooled) {
    output.warn(
      "tool_calls_unverified",
      `${result.provider} did not call the probe tool. Scans depend on tool calls; try the other wire API or another model.`,
    );
  }
  if (failed > 0) {
    throw new CliError(
      "platform",
      `Checked ${results.length - failed} of ${results.length} providers. ${failed} failed.`,
      {
        reason: "provider_error",
        rows: results
          .filter((result) => !result.ok)
          .map((result) => [result.provider, result.failure?.message ?? "failed"]),
        ...(results.some((result) => result.failure?.kind === "bad_request")
          ? {
              hint: "A provider that rejects the reasoning effort can have its own: providers update <provider> --effort <VALUE>. The value default sends none.",
            }
          : {}),
        data: { results: results.map(checkDocument) },
      },
    );
  }
  return 0;
}

async function providerModels(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal, env } = context;
  const config = await loadUserConfig(context);
  const all = availableProviders(config, env);
  const selected = args.positionals[0];
  const provider =
    selected === undefined
      ? all.find((item) => item.disabled !== true)
      : all.find((item) => item.name.toLowerCase() === selected.toLowerCase());
  if (!provider) {
    if (selected !== undefined) findIndex(config, selected);
    throw new CliError(
      "missing_input",
      "Can't list models without a provider. None is configured.",
      {
        reason: "missing_provider",
        next: [{ label: "Add one", argv: [BIN, "providers", "add"] }],
      },
    );
  }
  const listing = await listModels(
    resolveProvider(provider, env, await loadKeys(context)),
    context.signal,
  );
  if (!listing.ok) {
    throw new CliError(
      listing.failure?.kind === "auth" ? "auth" : "network",
      `Couldn't list models from ${provider.name}. ${listing.failure?.message ?? ""}`.trim(),
      {
        reason: listing.failure?.kind === "auth" ? "invalid_credentials" : "network_error",
        hint: "Some endpoints do not publish a model list. Set the model ID directly with providers update.",
      },
    );
  }
  if (terminal.json) {
    output.json({
      models: listing.models.map((id) => ({ id, current: id === provider.model })),
      provider: provider.name,
      pagination: { next: null },
    });
    return 0;
  }
  if (listing.models.length === 0) {
    output.info(`  No models listed by ${provider.name}.`);
    return 0;
  }
  if (output.out.rich) output.row("Provider", provider.name);
  for (const id of listing.models)
    output.line(output.out.rich ? `  ${id}${id === provider.model ? "  (current)" : ""}` : id);
  return 0;
}

const NAME_ARGUMENT = { name: "provider", description: "Provider name", required: true } as const;
const JSON_OPTION = {
  name: "json",
  type: "boolean",
  description: "Output the result as JSON",
} as const;

const EDIT_OPTIONS = [
  {
    name: "base-url",
    type: "string",
    hint: "<URL>",
    description: "Endpoint base URL up to the version segment, such as https://api.example.com/v1",
  },
  { name: "model", type: "string", hint: "<NAME>", description: "Model ID to request" },
  {
    name: "api-key-env",
    type: "string",
    hint: "<NAME>",
    description: "Environment variable that holds the API key",
  },
  {
    name: "api-key-stdin",
    type: "boolean",
    description: "Read the API key from stdin and store it where scans cannot read it",
  },
  {
    name: "wire-api",
    type: "string",
    hint: "<TYPE>",
    choices: WIRE_APIS,
    description: "API the endpoint speaks: responses or chat",
  },
  {
    name: "header",
    type: "list",
    hint: "<KEY=VALUE>",
    description: "Extra request header, comma-separated; values may use {session_id} and {api_key}",
  },
  {
    name: "effort",
    type: "string",
    hint: "<VALUE>",
    description: 'Reasoning effort for this provider; "default" sends none',
  },
  {
    name: "context-window",
    type: "number",
    hint: "<NUMBER>",
    description: "Model context window in tokens",
  },
] as const;

export const providersCommand: CommandSpec<AppContext> = {
  name: "providers",
  aliases: ["provider"],
  group: "Configure",
  summary: "Manage model endpoints and their fallback order",
  defaultSubcommand: "list",
  subcommands: [
    {
      name: "list",
      aliases: ["ls"],
      summary: "List providers in fallback order",
      options: [JSON_OPTION],
      notes: [
        "The first enabled provider is primary. The others are tried in order when it fails.",
      ],
      run: listProviders,
    },
    {
      name: "add",
      summary: "Add an OpenAI-compatible endpoint",
      arguments: [
        { name: "name", description: "Name for the provider (default: the preset or host name)" },
      ],
      options: [
        {
          name: "preset",
          type: "string",
          hint: "<NAME>",
          description: `Start from a known endpoint: ${PROVIDER_PRESETS.map((preset) => preset.id).join(", ")}`,
        },
        ...EDIT_OPTIONS,
        {
          name: "first",
          type: "boolean",
          description: "Make it the primary provider instead of the last fallback",
        },
        {
          name: "check",
          type: "boolean",
          negated: true,
          description: "Save without testing the endpoint",
        },
        {
          name: "force",
          type: "boolean",
          description: "Replace an existing provider with the same name",
        },
        JSON_OPTION,
      ],
      examples: [
        { label: "Add a provider step by step", argv: [BIN, "providers", "add"] },
        {
          label: "Add an endpoint with its key in an environment variable",
          argv: [
            BIN,
            "providers",
            "add",
            "--base-url",
            "<URL>",
            "--model",
            "<NAME>",
            "--api-key-env",
            "<NAME>",
          ],
        },
        {
          label: "Add a preset as the last fallback",
          argv: [BIN, "providers", "add", "--preset", "logfare", "--model", "<NAME>"],
        },
      ],
      notes: [
        "Without --wire-api, both APIs are probed and the working one is saved.",
        "The endpoint is tested before anything is saved.",
        "--api-key-stdin stores the key in a file only you can read, in a directory the scan sandbox is denied, so scans never see it.",
        "--force replaces the whole provider, stored key included. Give the key again, or use providers update to change single fields.",
      ],
      run: addProvider,
    },
    {
      name: "update",
      summary: "Change the specified fields of a provider",
      arguments: [NAME_ARGUMENT],
      options: [
        ...EDIT_OPTIONS,
        { name: "name", type: "string", hint: "<NAME>", description: "New name for the provider" },
        JSON_OPTION,
      ],
      examples: [
        {
          label: "Switch the model",
          argv: [BIN, "providers", "update", "<PROVIDER>", "--model", "<NAME>"],
        },
      ],
      run: updateProvider,
    },
    {
      name: "remove",
      aliases: ["rm"],
      summary: "Remove a provider and its stored key",
      arguments: [NAME_ARGUMENT],
      options: [JSON_OPTION],
      run: removeProvider,
    },
    {
      name: "move",
      summary: "Change a provider's position in the fallback order",
      arguments: [NAME_ARGUMENT],
      options: [
        {
          name: "position",
          type: "number",
          hint: "<NUMBER>",
          description: "New position, starting at 1",
        },
        { name: "first", type: "boolean", description: "Make it the primary provider" },
        { name: "last", type: "boolean", description: "Make it the last fallback" },
        JSON_OPTION,
      ],
      examples: [
        {
          label: "Make a provider primary",
          argv: [BIN, "providers", "move", "<PROVIDER>", "--first"],
        },
      ],
      run: moveProvider,
    },
    {
      name: "enable",
      summary: "Put a provider back in the chain",
      arguments: [NAME_ARGUMENT],
      options: [JSON_OPTION],
      run: toggleProvider(false),
    },
    {
      name: "disable",
      summary: "Keep a provider configured but out of the chain",
      arguments: [NAME_ARGUMENT],
      options: [JSON_OPTION],
      run: toggleProvider(true),
    },
    {
      name: "check",
      summary: "Send a test request through each provider",
      arguments: [
        { name: "provider", description: "Provider to check (default: every enabled provider)" },
      ],
      options: [
        {
          name: "effort",
          type: "string",
          hint: "<VALUE>",
          description: "Reasoning effort to request",
          defaultText: "the scan effort",
        },
        JSON_OPTION,
      ],
      notes: [
        "The test asks the model to call a tool, because scans depend on tool calls. It spends a few hundred tokens per provider.",
      ],
      run: checkProviders,
    },
    {
      name: "models",
      summary: "List the model IDs an endpoint offers",
      arguments: [
        { name: "provider", description: "Provider to query (default: the primary provider)" },
      ],
      options: [JSON_OPTION],
      run: providerModels,
    },
  ],
};
