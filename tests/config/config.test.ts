import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteProviderKey,
  loadStoredKeys,
  renameProviderKey,
  setProviderKey,
} from "../../src/config/credentials.js";
import {
  flattenConfig,
  getValue,
  isSecretValue,
  maskSecret,
  redact,
  settingDocs,
  setValue,
  splitKey,
  unsetValue,
} from "../../src/config/keys.js";
import { findPreset, PROVIDER_PRESETS } from "../../src/config/presets.js";
import { type Config, ConfigSchema } from "../../src/config/schema.js";
import {
  loadConfigFile,
  parseConfigText,
  saveConfigFile,
  updateConfigFile,
} from "../../src/config/store.js";
import { CliError } from "../../src/core/errors.js";
import { resolvePaths } from "../../src/core/paths.js";
import { isOpenAiEndpoint, resolveProvider } from "../../src/providers/resolve.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kongyo-scan-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const sample: Config = {
  providers: [
    {
      name: "primary",
      base_url: "https://api.example.com/v1",
      model: "model-a",
      wire_api: "responses",
    },
    { name: "back.up", base_url: "http://localhost:11434/v1", model: "model-b" },
  ],
  reasoning_effort: "max",
  scan: { mode: "standard" },
};

function expectCliError(action: () => unknown): CliError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error("expected a CliError");
}

describe("config schema", () => {
  it("accepts the documented settings", () => {
    const parsed = ConfigSchema.parse({
      ...sample,
      scan: {
        mode: "deep",
        scope: { diff: { base: "origin/main" } },
        knowledge_base: ["docs"],
        deep: { workers: 2, subagents_per_worker: 0 },
      },
      limits: { max_cost_usd_per_scan: 5 },
      policy: { fail_on_severity: "high" },
      codex: { analytics: { enabled: false } },
      gateway: { cooldown_seconds: 30 },
    });
    expect(parsed.scan?.deep?.subagents_per_worker).toBe(0);
  });

  it("reports every problem with its key path, without echoing values", () => {
    const error = expectCliError(() =>
      parseConfigText(
        JSON.stringify({
          providers: [
            { name: "bad name!", base_url: "ftp://x", model: "", api_key: "sk-very-secret" },
          ],
          scan: { mode: "turbo" },
          surprise: true,
        }),
        "/tmp/config.json",
      ),
    );
    expect(error.reason).toBe("invalid_config");
    expect(error.exitCode).toBe(1);
    const fields = error.issues.map((issue) => issue.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        "providers[0].name",
        "providers[0].base_url",
        "providers[0].model",
        "scan.mode",
        "surprise",
      ]),
    );
    expect(JSON.stringify([error.message, error.details, error.issues])).not.toContain(
      "sk-very-secret",
    );
  });

  it("rejects URLs with embedded credentials and duplicate provider names", () => {
    expectCliError(() =>
      parseConfigText(
        JSON.stringify({
          providers: [{ name: "a", base_url: "https://user:pass@example.com/v1", model: "m" }],
        }),
        "c.json",
      ),
    );
    const duplicate = expectCliError(() =>
      parseConfigText(
        JSON.stringify({
          providers: [
            { name: "Same", base_url: "https://a.example/v1", model: "m" },
            { name: "same", base_url: "https://b.example/v1", model: "m" },
          ],
        }),
        "c.json",
      ),
    );
    expect(duplicate.message).toContain("unique names");
  });

  it("points at the location of a JSON syntax error and masks values in the frame", () => {
    const error = expectCliError(() =>
      parseConfigText(
        '{\n  "providers": [],\n  "reasoning_effort": "secret-ish"\n  "scan": {}\n}',
        "/tmp/config.json",
      ),
    );
    expect(error.message).toMatch(/^\/tmp\/config\.json:\d+:\d+ isn't valid JSON\.$/u);
    expect(error.details.join("\n")).not.toContain("secret-ish");
    expect(error.details.at(-1)).toContain("^");
  });
});

describe("config store", () => {
  it("treats a missing file as empty and a broken one as an error", async () => {
    const file = join(directory, "nested", "config.json");
    expect(await loadConfigFile(file)).toMatchObject({ config: {}, exists: false });
    await saveConfigFile(file, sample);
    await writeFile(file, "{ not json", "utf8");
    await expect(loadConfigFile(file)).rejects.toBeInstanceOf(CliError);
  });

  it("writes atomically, owner-only, and leaves no temporary files", async () => {
    const file = join(directory, "config.json");
    await saveConfigFile(file, sample);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(sample);
    expect(await readdir(directory)).toEqual(["config.json"]);
  });

  it("refuses to save an invalid config and keeps the previous file", async () => {
    const file = join(directory, "config.json");
    await saveConfigFile(file, sample);
    await expect(
      saveConfigFile(file, { scan: { mode: "nope" } } as unknown as Config),
    ).rejects.toBeInstanceOf(CliError);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(sample);
  });

  it("applies changes made at the same time one after another, losing none", async () => {
    const file = join(directory, "config.json");
    await saveConfigFile(file, sample);
    const names = Array.from({ length: 12 }, (_, index) => `added-${index}`);
    await Promise.all([
      updateConfigFile(file, (config) => {
        config.reasoning_effort = "high";
      }),
      updateConfigFile(file, (config) => {
        config.policy = { fail_on_severity: "high" };
      }),
      ...names.map((name) =>
        updateConfigFile(file, (config) => {
          config.providers = [
            ...(config.providers ?? []),
            { name, base_url: "https://api.example.com/v1", model: "m" },
          ];
        }),
      ),
    ]);
    const { config } = await loadConfigFile(file);
    expect(config.reasoning_effort).toBe("high");
    expect(config.policy).toEqual({ fail_on_severity: "high" });
    expect(config.providers?.map((provider) => provider.name).sort()).toEqual(
      ["primary", "back.up", ...names].sort(),
    );
    expect(await readdir(directory)).toEqual(["config.json"]);
  });

  it("writes nothing when a change leaves the settings as they were", async () => {
    const file = join(directory, "config.json");
    expect(await updateConfigFile(file, () => undefined)).toEqual({});
    expect(await readdir(directory)).toEqual([]);
    await saveConfigFile(file, sample);
    const before = (await stat(file)).mtimeMs;
    await updateConfigFile(file, (config) => {
      config.reasoning_effort = "max";
    });
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it("takes over a lock left by a process that died and releases its own on failure", async () => {
    const file = join(directory, "config.json");
    await saveConfigFile(file, sample);
    const lock = `${file}.lock`;
    await writeFile(lock, "", "utf8");
    const longAgo = new Date(Date.now() - 5 * 60_000);
    await utimes(lock, longAgo, longAgo);
    await updateConfigFile(file, (config) => {
      config.reasoning_effort = "low";
    });
    expect((await loadConfigFile(file)).config.reasoning_effort).toBe("low");

    await expect(
      updateConfigFile(file, () => {
        throw new Error("change failed");
      }),
    ).rejects.toThrow("change failed");
    expect(await readdir(directory)).toEqual(["config.json"]);
  });
});

describe("setting names", () => {
  it("addresses providers by name, including names that contain dots", () => {
    expect(splitKey("providers.back.up.model", sample)).toEqual(["providers", "back.up", "model"]);
    expect(getValue(sample, "providers.back.up.model")).toBe("model-b");
    expect(getValue(sample, "providers.primary.wire_api")).toBe("responses");
    expect(getValue(sample, "scan.deep.workers")).toBeUndefined();
  });

  it("sets values with the interpretation the schema accepts", () => {
    let config = setValue(sample, "scan.max_time_minutes", "15", "c.json");
    expect(config.scan?.max_time_minutes).toBe(15);
    config = setValue(config, "reasoning_effort", "high", "c.json");
    expect(config.reasoning_effort).toBe("high");
    config = setValue(config, "scan.knowledge_base", '["docs","SECURITY.md"]', "c.json");
    expect(config.scan?.knowledge_base).toEqual(["docs", "SECURITY.md"]);
    config = setValue(config, "codex.analytics.enabled", "false", "c.json");
    expect(config.codex).toEqual({ analytics: { enabled: false } });
    config = setValue(config, "providers.primary.model", "4", "c.json");
    expect(config.providers?.[0]?.model).toBe("4");
    expect(sample.providers?.[0]?.model).toBe("model-a");
  });

  it("rejects invalid values, unknown providers, and settings the gateway owns", () => {
    expect(expectCliError(() => setValue(sample, "scan.mode", "turbo", "c.json")).exitCode).toBe(2);
    expect(
      expectCliError(() => setValue(sample, "providers.ghost.model", "m", "c.json")).reason,
    ).toBe("provider_not_found");
    expect(
      expectCliError(() => setValue(sample, "codex.model_provider", "x", "c.json")).message,
    ).toContain("manages it");
    expect(
      expectCliError(() => setValue(sample, "codex.__proto__.x", "1", "c.json")).exitCode,
    ).toBe(2);
  });

  it("unsets values and prunes emptied objects", () => {
    const { config, changed } = unsetValue(
      setValue(sample, "policy.fail_on_severity", "high", "c.json"),
      "policy.fail_on_severity",
      "c.json",
    );
    expect(changed).toBe(true);
    expect(config.policy).toBeUndefined();
    expect(unsetValue(sample, "limits.max_cost_usd_per_scan", "c.json").changed).toBe(false);
    expect(
      unsetValue(sample, "providers.primary", "c.json").config.providers?.map(
        (provider) => provider.name,
      ),
    ).toEqual(["back.up"]);
  });

  it("documents every setting and flattens values with secrets marked", () => {
    const keys = settingDocs().map((doc) => doc.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "reasoning_effort",
        "scan.mode",
        "scan.scope.paths",
        "scan.deep.workers",
        "policy.fail_on_severity",
        "providers.<name>.base_url",
        "providers.<name>.pricing.input_per_mtok",
        "gateway.cooldown_seconds",
      ]),
    );
    const rows = flattenConfig({
      providers: [
        { name: "p", base_url: "https://a.example/v1", model: "m", api_key: "sk-1234567890abcdef" },
      ],
    });
    expect(rows.find((row) => row.key === "providers.p.api_key")).toMatchObject({ secret: true });
    expect(maskSecret("sk-1234567890abcdef")).toBe("****cdef");
    expect(maskSecret("short")).toBe("****");
  });

  it("recognizes credentials by the name of the setting that holds them", () => {
    const secret = (key: string, value = "literal-credential-value"): boolean =>
      isSecretValue(key.split("/"), value);
    for (const key of [
      "providers/p/api_key",
      "providers/p/headers/Authorization",
      "providers/p/headers/Proxy-Authorization",
      "providers/p/headers/x-api-key",
      "providers/p/headers/X-Goog-Api-Key",
      "providers/p/headers/Ocp-Apim-Subscription-Key",
      "providers/p/headers/x-auth-token",
      "providers/p/headers/Cookie",
      "providers/p/query_params/key",
      "providers/p/query_params/access_token",
      "providers/p/query_params/signature",
      "codex/mcp_servers/tracker/env/TRACKER_API_TOKEN",
      "codex/mcp_servers/tracker/bearer_token",
      "codex/some/client_secret",
    ]) {
      expect(secret(key), key).toBe(true);
    }
    for (const key of [
      "providers/p/model",
      "providers/p/api_key_env",
      "providers/p/max_output_tokens",
      "providers/p/headers/x-opencode-session",
      "providers/p/headers/HTTP-Referer",
      "providers/p/query_params/api-version",
      "providers/token",
      "reasoning_effort",
    ]) {
      expect(secret(key), key).toBe(false);
    }
    expect(secret("providers/p/headers/Authorization", "Bearer {api_key}")).toBe(false);
    expect(secret("providers/p/headers/x-api-key", "{api_key}")).toBe(false);
    expect(secret("providers/p/headers/x-session-token", "{session_id}")).toBe(false);
    expect(secret("providers/p/headers/Authorization", "Bearer sk-live-1234 {api_key}")).toBe(true);
  });

  it("masks credentials wherever they sit in a value being shown", () => {
    const headers = {
      Authorization: "Bearer sk-live-0123456789abcdef",
      "x-opencode-session": "{session_id}",
      "x-api-key": "{api_key}",
    };
    expect(redact(headers, ["providers", "p", "headers"])).toEqual({
      Authorization: "****cdef",
      "x-opencode-session": "{session_id}",
      "x-api-key": "{api_key}",
    });
    expect(
      redact({
        providers: [
          {
            name: "p",
            base_url: "https://a.example/v1",
            model: "m",
            api_key: "sk-1234567890abcdef",
            headers,
            query_params: { key: "AIza-0123456789abcdef", "api-version": "2026-01-01" },
          },
        ],
        codex: { mcp_servers: { tracker: { env: { TRACKER_TOKEN: "tok-0123456789abcdef" } } } },
      }),
    ).toEqual({
      providers: [
        {
          name: "p",
          base_url: "https://a.example/v1",
          model: "m",
          api_key: "****cdef",
          headers: {
            Authorization: "****cdef",
            "x-opencode-session": "{session_id}",
            "x-api-key": "{api_key}",
          },
          query_params: { key: "****cdef", "api-version": "2026-01-01" },
        },
      ],
      codex: { mcp_servers: { tracker: { env: { TRACKER_TOKEN: "****cdef" } } } },
    });
  });
});

describe("stored keys", () => {
  it("keeps keys in an owner-only file inside the directory scans cannot read", async () => {
    const paths = resolvePaths({ KONGYO_SCAN_HOME: directory });
    expect(paths.credentialsFile).toBe(
      join(directory, "state", "codex-home", "kongyo-scan-credentials.json"),
    );
    await setProviderKey(paths.credentialsFile, "Primary", "sk-one");
    await setProviderKey(paths.credentialsFile, "other", "sk-two");
    expect((await stat(paths.credentialsFile)).mode & 0o777).toBe(0o600);
    expect(await loadStoredKeys(paths.credentialsFile)).toEqual({
      primary: "sk-one",
      other: "sk-two",
    });
    await renameProviderKey(paths.credentialsFile, "primary", "main");
    expect(await deleteProviderKey(paths.credentialsFile, "other")).toBe(true);
    expect(await deleteProviderKey(paths.credentialsFile, "other")).toBe(false);
    expect(await loadStoredKeys(paths.credentialsFile)).toEqual({ main: "sk-one" });
  });

  it("never echoes a corrupt credentials file", async () => {
    const file = join(directory, "credentials.json");
    await writeFile(file, '{"providers": {"p": {"api_key": "sk-leaky"', "utf8");
    const error = await loadStoredKeys(file).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CliError);
    expect(
      JSON.stringify([(error as CliError).message, (error as CliError).details]),
    ).not.toContain("sk-leaky");
  });
});

describe("presets", () => {
  it("are valid provider definitions", () => {
    for (const preset of PROVIDER_PRESETS) {
      const result = ConfigSchema.safeParse({
        providers: [
          {
            name: preset.id,
            base_url: preset.base_url,
            model: "m",
            wire_api: preset.wire_api,
            ...(preset.headers ? { headers: preset.headers } : {}),
          },
        ],
      });
      expect(result.success, preset.id).toBe(true);
    }
    expect(findPreset("OpenCode-Go")?.base_url).toBe("https://opencode.ai/inference/go/openai/v1");
    expect(findPreset("logfare")?.base_url).toBe("https://logfare.ai/v1");
    expect(findPreset("nope")).toBeUndefined();
  });
});

describe("provider resolution", () => {
  const base = { name: "p", base_url: "https://api.example.com/v1/", model: "m" };

  it("prefers a set environment variable, then a stored key, then an inline key", () => {
    const provider = { ...base, api_key: "inline", api_key_env: "P_KEY" };
    expect(resolveProvider(provider, { P_KEY: " from-env " }, { p: "stored" })).toMatchObject({
      apiKey: "from-env",
      apiKeySource: "environment variable P_KEY",
      baseUrl: "https://api.example.com/v1",
    });
    expect(resolveProvider(provider, { P_KEY: "" }, { p: "stored" })).toMatchObject({
      apiKey: "stored",
      apiKeySource: "stored key",
    });
    expect(resolveProvider(provider, {}, {})).toMatchObject({
      apiKey: "inline",
      apiKeySource: "settings file",
    });
    expect(resolveProvider(base, {}, {}).apiKey).toBeUndefined();
  });

  it("sends OpenAI's native request shape only to OpenAI, unless told otherwise", () => {
    expect(isOpenAiEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAiEndpoint("https://api.openai.com.example.net/v1")).toBe(false);
    expect(resolveProvider(base, {}, {}).compat.nativeResponses).toBe(false);
    expect(
      resolveProvider({ ...base, base_url: "https://API.OpenAI.com/v1" }, {}, {}).compat
        .nativeResponses,
    ).toBe(true);
    expect(
      resolveProvider({ ...base, compat: { native_responses: true } }, {}, {}).compat
        .nativeResponses,
    ).toBe(true);
    expect(
      resolveProvider(
        { ...base, base_url: "https://api.openai.com/v1", compat: { native_responses: false } },
        {},
        {},
      ).compat.nativeResponses,
    ).toBe(false);
  });

  it("applies defaults for timeouts, pricing, and compatibility", () => {
    const resolved = resolveProvider(
      { ...base, timeout_seconds: 30, pricing: { input_per_mtok: 2, output_per_mtok: 8 } },
      {},
      {},
    );
    expect(resolved).toMatchObject({
      wireApi: "chat",
      firstByteTimeoutMs: 30_000,
      pricing: { inputPerMtok: 2, cachedInputPerMtok: 2, outputPerMtok: 8 },
      compat: { images: true, omitParams: [], extraBody: {} },
    });
    expect(resolveProvider(base, {}, {}).firstByteTimeoutMs).toBe(180_000);
  });
});
