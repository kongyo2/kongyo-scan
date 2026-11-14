import type { StoredKeys } from "../config/credentials.js";
import { type Config, type ProviderConfig, WIRE_APIS, type WireApi } from "../config/schema.js";
import { CliError, usageError } from "../core/errors.js";
import type { ResolvedProvider } from "../gateway/types.js";

export const DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS = 180;

export const ENV_PROVIDER_NAME = "env";
export const ENV_BASE_URL = "KONGYO_SCAN_BASE_URL";
export const ENV_MODEL = "KONGYO_SCAN_MODEL";
export const ENV_API_KEY = "KONGYO_SCAN_API_KEY";
export const ENV_WIRE_API = "KONGYO_SCAN_WIRE_API";

type Env = Readonly<Record<string, string | undefined>>;

export const KEY_SOURCE_STORED = "stored key";
export const KEY_SOURCE_INLINE = "settings file";

export function resolveProvider(
  provider: ProviderConfig,
  env: Env = process.env,
  keys: StoredKeys = {},
): ResolvedProvider {
  let apiKey: string | undefined;
  let apiKeySource: string | undefined;
  const fromEnv = provider.api_key_env === undefined ? undefined : env[provider.api_key_env];
  const stored = keys[provider.name.toLowerCase()];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    apiKey = fromEnv.trim();
    apiKeySource = `environment variable ${provider.api_key_env}`;
  } else if (stored !== undefined) {
    apiKey = stored;
    apiKeySource = KEY_SOURCE_STORED;
  } else if (provider.api_key !== undefined) {
    apiKey = provider.api_key;
    apiKeySource = KEY_SOURCE_INLINE;
  }
  const input = provider.pricing?.input_per_mtok;
  return {
    name: provider.name,
    baseUrl: provider.base_url.replace(/\/+$/u, ""),
    model: provider.model,
    wireApi: provider.wire_api ?? "chat",
    apiKey,
    apiKeySource,
    headers: { ...provider.headers },
    queryParams: { ...provider.query_params },
    reasoningEffort: provider.reasoning_effort,
    contextWindow: provider.context_window,
    maxOutputTokens: provider.max_output_tokens,
    firstByteTimeoutMs: (provider.timeout_seconds ?? DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS) * 1000,
    pricing:
      provider.pricing === undefined || input === undefined
        ? undefined
        : {
            inputPerMtok: input,
            cachedInputPerMtok: provider.pricing.cached_input_per_mtok ?? input,
            outputPerMtok: provider.pricing.output_per_mtok,
          },
    compat: {
      nativeResponses: provider.compat?.native_responses ?? isOpenAiEndpoint(provider.base_url),
      images: provider.compat?.images ?? true,
      omitParams: provider.compat?.omit_params ?? [],
      extraBody: provider.compat?.extra_body ?? {},
    },
  };
}

export function envProvider(env: Env = process.env): ProviderConfig | undefined {
  const baseUrl = env[ENV_BASE_URL]?.trim();
  const model = env[ENV_MODEL]?.trim();
  if (!baseUrl && !model) return undefined;
  if (!baseUrl || !model) {
    throw usageError(
      `Can't use ${baseUrl ? ENV_BASE_URL : ENV_MODEL} alone. Set both ${ENV_BASE_URL} and ${ENV_MODEL}.`,
    );
  }
  const wire = env[ENV_WIRE_API]?.trim();
  if (wire !== undefined && wire !== "" && !(WIRE_APIS as readonly string[]).includes(wire)) {
    throw usageError(`Can't use ${ENV_WIRE_API}=${wire}. Use responses or chat.`);
  }
  const provider: ProviderConfig = { name: ENV_PROVIDER_NAME, base_url: baseUrl, model };
  if (wire) provider.wire_api = wire as WireApi;
  if (env[ENV_API_KEY]?.trim()) provider.api_key_env = ENV_API_KEY;
  return provider;
}

export function isOpenAiEndpoint(baseUrl: string): boolean {
  return URL.parse(baseUrl)?.hostname.toLowerCase() === "api.openai.com";
}

export function availableProviders(config: Config, env: Env = process.env): ProviderConfig[] {
  const configured = config.providers ?? [];
  const fromEnv = envProvider(env);
  if (!fromEnv) return configured;
  return [
    fromEnv,
    ...configured.filter((provider) => provider.name.toLowerCase() !== ENV_PROVIDER_NAME),
  ];
}

export interface ChainSelection {
  names?: readonly string[] | undefined;
  model?: string | undefined;
  noFallback?: boolean | undefined;
}

export function buildChain(
  config: Config,
  selection: ChainSelection = {},
  env: Env = process.env,
  keys: StoredKeys = {},
): ResolvedProvider[] {
  const available = availableProviders(config, env);
  let chosen: ProviderConfig[];
  if (selection.names && selection.names.length > 0) {
    chosen = selection.names.map((name) => {
      const match = available.find(
        (provider) => provider.name.toLowerCase() === name.toLowerCase(),
      );
      if (!match) {
        throw new CliError("not_found", `Couldn't find provider ${JSON.stringify(name)}.`, {
          reason: "provider_not_found",
          data: { providers: available.map((provider) => provider.name) },
          next: [
            { label: "List configured providers", argv: ["kongyo-scan", "providers", "list"] },
          ],
        });
      }
      return match;
    });
    const duplicates = chosen.filter((provider, index) => chosen.indexOf(provider) !== index);
    if (duplicates.length > 0) {
      throw usageError(`Can't use provider ${duplicates[0]!.name} twice in --provider.`);
    }
  } else {
    chosen = available.filter((provider) => provider.disabled !== true);
  }
  if (selection.noFallback) chosen = chosen.slice(0, 1);
  const chain = chosen.map((provider) => resolveProvider(provider, env, keys));
  if (selection.model !== undefined && chain[0]) chain[0] = { ...chain[0], model: selection.model };
  return chain;
}

export function missingProviderError(): CliError {
  return new CliError("missing_input", "Can't scan without a model provider. None is configured.", {
    reason: "missing_provider",
    next: [
      {
        label: "Add a provider",
        argv: [
          "kongyo-scan",
          "providers",
          "add",
          "--base-url",
          "<URL>",
          "--model",
          "<MODEL>",
          "--api-key-env",
          "<NAME>",
        ],
        when: "Replace <URL>, <MODEL>, and <NAME> with your endpoint, model ID, and key variable",
      },
    ],
  });
}
