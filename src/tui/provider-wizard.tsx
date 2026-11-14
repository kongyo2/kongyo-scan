import { Box, render, Text, useInput } from "ink";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import type { AppContext } from "../app/context.js";
import { loadKeys, loadUserConfig } from "../app/context.js";
import { formatDuration } from "../cli/format.js";
import { formatCommand } from "../cli/output.js";
import { buildProvider, keyLabel, verifyProvider } from "../commands/providers.js";
import { setProviderKey, type StoredKeys } from "../config/credentials.js";
import { CUSTOM_PRESET_ID, findPreset, PROVIDER_PRESETS } from "../config/presets.js";
import {
  type Config,
  DEFAULT_REASONING_EFFORT,
  ENV_NAME_PATTERN,
  type ProviderConfig,
  PROVIDER_NAME_PATTERN,
} from "../config/schema.js";
import { updateConfigFile } from "../config/store.js";
import { CanceledError, CliError, describeError } from "../core/errors.js";
import { type CheckResult, listModels } from "../providers/check.js";
import { ENV_PROVIDER_NAME, resolveProvider } from "../providers/resolve.js";
import { BIN } from "../version.js";
import {
  type Choice,
  ColorProvider,
  Faint,
  KeyHints,
  Row,
  SelectList,
  Spinner,
  TextField,
  Tint,
  useListRows,
} from "./components.js";

type KeyMode = "env" | "paste" | "none";
type Step =
  | "preset"
  | "baseUrl"
  | "keyMode"
  | "keyValue"
  | "envName"
  | "models"
  | "model"
  | "modelManual"
  | "name"
  | "checking"
  | "review"
  | "saving";

const BACK = "__back__";
const MANUAL = "__manual__";

export interface WizardResult {
  provider: ProviderConfig;
  check: CheckResult | undefined;
  keyMode: KeyMode;
  position: number;
  total: number;
}

export interface ProviderWizardProps {
  env: NodeJS.ProcessEnv;
  config: Config;
  keys: StoredKeys;
  first: boolean;
  initialName?: string | undefined;
  signal: AbortSignal;
  save: (
    provider: ProviderConfig,
    apiKey: string | undefined,
  ) => Promise<{ position: number; total: number }>;
  onDone: (result: WizardResult) => void;
  onCancel: () => void;
}

function hostName(baseUrl: string): string {
  const host = URL.parse(baseUrl)?.hostname ?? "provider";
  const parts = host
    .split(".")
    .filter(
      (part) => !["www", "api", "com", "ai", "io", "net", "org", "dev", "app"].includes(part),
    );
  return (parts.at(-1) ?? host).replaceAll(/[^A-Za-z0-9._-]/gu, "-") || "provider";
}

export function ProviderWizard(props: ProviderWizardProps): ReactNode {
  const scanEffort = props.config.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
  const presetRows = useListRows(12, 9);
  const modelRows = useListRows(10, 10);
  const [step, setStep] = useState<Step>("preset");
  const [presetId, setPresetId] = useState<string>(CUSTOM_PRESET_ID);
  const [baseUrl, setBaseUrl] = useState("");
  const [keyMode, setKeyMode] = useState<KeyMode>("paste");
  const [apiKey, setApiKey] = useState("");
  const [envName, setEnvName] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsNote, setModelsNote] = useState<string | undefined>();
  const [model, setModel] = useState("");
  const [name, setName] = useState(props.initialName ?? "");
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState<ProviderConfig | undefined>();
  const [check, setCheck] = useState<CheckResult | undefined>();

  const preset = presetId === CUSTOM_PRESET_ID ? undefined : findPreset(presetId);
  const effectiveBaseUrl = preset?.base_url ?? baseUrl.trim();
  const taken = useMemo(
    () => new Set((props.config.providers ?? []).map((provider) => provider.name.toLowerCase())),
    [props.config],
  );
  const go = (next: Step): void => {
    setError(undefined);
    setStep(next);
  };

  const candidate = (): ProviderConfig =>
    buildProvider(
      {
        name: name.trim() || undefined,
        preset: presetId,
        baseUrl: preset ? undefined : baseUrl.trim(),
        model: model.trim(),
        apiKeyEnv: keyMode === "env" ? envName.trim() : undefined,
        hasKey: keyMode === "paste",
        wireApi: undefined,
        headers: undefined,
        effort: undefined,
        contextWindow: undefined,
      },
      props.env,
    );
  const candidateKeys = (provider: ProviderConfig): StoredKeys =>
    keyMode === "paste"
      ? { ...props.keys, [provider.name.toLowerCase()]: apiKey.trim() }
      : props.keys;

  useEffect(() => {
    if (step !== "models") return;
    let active = true;
    const probe: ProviderConfig = {
      name: "wizard-probe",
      base_url: effectiveBaseUrl,
      model: "probe",
    };
    if (keyMode === "env") probe.api_key_env = envName.trim();
    if (preset?.headers) probe.headers = { ...preset.headers };
    const resolved = resolveProvider(
      probe,
      props.env,
      keyMode === "paste" ? { "wizard-probe": apiKey.trim() } : {},
    );
    void (async () => {
      const listing = await listModels(resolved, props.signal);
      if (!active) return;
      if (listing.ok && listing.models.length > 0) {
        setModels(listing.models);
        setModelsNote(undefined);
        go("model");
      } else {
        setModels([]);
        setModelsNote(
          listing.ok
            ? "The endpoint lists no models."
            : `Couldn't list models (${listing.failure?.message ?? "no answer"}).`,
        );
        go("modelManual");
      }
    })();
    return () => {
      active = false;
    };
  }, [step]);

  useEffect(() => {
    if (step !== "checking") return;
    let active = true;
    let provider: ProviderConfig;
    try {
      provider = candidate();
    } catch (failure) {
      setError(failure instanceof CliError ? failure.message : describeError(failure));
      setStep("name");
      return;
    }
    void (async () => {
      try {
        const verified = await verifyProvider(
          provider,
          props.env,
          props.signal,
          scanEffort,
          candidateKeys(provider),
        );
        if (!active) return;
        setDraft(
          verified.provider.wire_api === undefined
            ? { ...verified.provider, wire_api: "chat" }
            : verified.provider,
        );
        setCheck(verified.result);
        setStep("review");
      } catch (failure) {
        if (!active) return;
        setError(describeError(failure));
        setStep("name");
      }
    })();
    return () => {
      active = false;
    };
  }, [step]);

  useEffect(() => {
    if (step !== "saving" || !draft) return;
    let active = true;
    void (async () => {
      let saved: { position: number; total: number };
      try {
        saved = await props.save(draft, keyMode === "paste" ? apiKey.trim() : undefined);
      } catch (failure) {
        if (!active) return;
        setError(failure instanceof CliError ? failure.message : describeError(failure));
        setStep("review");
        return;
      }
      if (active)
        props.onDone({
          provider: draft,
          check,
          keyMode,
          position: saved.position,
          total: saved.total,
        });
    })();
    return () => {
      active = false;
    };
  }, [step]);

  useInput(
    (_input, key) => {
      if (key.escape) props.onCancel();
    },
    { isActive: step === "models" || step === "checking" || step === "saving" },
  );

  const title = (text: string, hint?: string): ReactNode => (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{text}</Text>
      {hint ? <Faint>{hint}</Faint> : null}
    </Box>
  );
  const problem = error ? (
    <Box marginTop={1}>
      <Tint tone="danger">✗ </Tint>
      <Text>{error}</Text>
    </Box>
  ) : null;

  const answered: [string, string][] = [];
  if (step !== "preset")
    answered.push([
      "Endpoint",
      preset ? `${preset.label} (${preset.base_url})` : effectiveBaseUrl || "custom",
    ]);
  if (!["preset", "baseUrl", "keyMode", "keyValue", "envName"].includes(step)) {
    answered.push([
      "Key",
      keyMode === "env"
        ? `$${envName}`
        : keyMode === "paste"
          ? "pasted, stored where scans cannot read it"
          : "none",
    ]);
  }
  if (["name", "checking", "review", "saving"].includes(step)) answered.push(["Model", model]);
  if (["checking", "review", "saving"].includes(step) && draft === undefined && name)
    answered.push(["Name", name]);

  let body: ReactNode;
  switch (step) {
    case "preset": {
      const choices: Choice<string>[] = [
        ...PROVIDER_PRESETS.map((item) => ({
          value: item.id,
          label: item.label,
          hint: item.description,
        })),
        {
          value: CUSTOM_PRESET_ID,
          label: "Other OpenAI-compatible endpoint",
          hint: "enter a base URL",
        },
      ];
      body = (
        <>
          {title(
            "Which endpoint?",
            "Any service that speaks the OpenAI Responses or Chat Completions API works.",
          )}
          <SelectList
            choices={choices}
            limit={presetRows}
            onCancel={props.onCancel}
            onSelect={(value) => {
              setPresetId(value);
              const chosen = findPreset(value);
              if (!props.initialName)
                setName(chosen ? (taken.has(chosen.id) ? "" : chosen.id) : "");
              const conventional = chosen?.api_key_env;
              setEnvName(conventional ?? "");
              setKeyMode(
                chosen && !chosen.needs_key
                  ? "none"
                  : conventional && (props.env[conventional] ?? "").trim()
                    ? "env"
                    : "paste",
              );
              go(chosen ? "keyMode" : "baseUrl");
            }}
          />
        </>
      );
      break;
    }
    case "baseUrl":
      body = (
        <>
          {title("Base URL?", "Up to the version segment, such as https://api.example.com/v1")}
          <TextField
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://"
            onCancel={props.onCancel}
            onSubmit={(value) => {
              const url = URL.parse(value.trim());
              if (!url || !["http:", "https:"].includes(url.protocol) || url.hostname === "") {
                setError("Enter an http(s) URL such as https://api.example.com/v1");
                return;
              }
              if (url.username || url.password) {
                setError("Leave credentials out of the URL; the key is asked for next.");
                return;
              }
              if (!props.initialName && name === "") {
                const derived = hostName(value.trim());
                setName(taken.has(derived.toLowerCase()) ? "" : derived);
              }
              go("keyMode");
            }}
          />
        </>
      );
      break;
    case "keyMode": {
      const conventional = preset?.api_key_env;
      const conventionalSet =
        conventional !== undefined && (props.env[conventional] ?? "").trim() !== "";
      const choices: Choice<string>[] = [];
      if (conventionalSet)
        choices.push({
          value: `env:${conventional}`,
          label: `Use $${conventional}`,
          hint: "already set in this shell",
        });
      choices.push({
        value: "paste",
        label: "Paste an API key",
        hint: "stored where scans cannot read it",
      });
      choices.push({
        value: "env",
        label: "Read it from an environment variable",
        hint: "nothing is stored",
      });
      choices.push({ value: "none", label: "No key", hint: "for servers on this machine" });
      choices.push({ value: BACK, label: "Back" });
      body = (
        <>
          {title("API key?")}
          <SelectList
            choices={choices}
            initialIndex={Math.max(
              0,
              choices.findIndex(
                (choice) =>
                  choice.value ===
                  (keyMode === "env" && conventionalSet ? `env:${conventional}` : keyMode),
              ),
            )}
            onCancel={props.onCancel}
            onSelect={(value) => {
              if (value === BACK) go(preset ? "preset" : "baseUrl");
              else if (value.startsWith("env:")) {
                setKeyMode("env");
                setEnvName(value.slice(4));
                go("models");
              } else if (value === "paste") {
                setKeyMode("paste");
                go("keyValue");
              } else if (value === "env") {
                setKeyMode("env");
                go("envName");
              } else {
                setKeyMode("none");
                go("models");
              }
            }}
          />
        </>
      );
      break;
    }
    case "keyValue":
      body = (
        <>
          {title(
            "Paste the API key",
            "It is hidden as you type and stored in a file only you can read.",
          )}
          <TextField
            value={apiKey}
            onChange={setApiKey}
            mask
            onCancel={props.onCancel}
            onSubmit={(value) => {
              if (value.trim() === "") {
                setError("Paste a key, or press Escape to cancel.");
                return;
              }
              go("models");
            }}
          />
        </>
      );
      break;
    case "envName":
      body = (
        <>
          {title("Environment variable name?", "The key is read from it each time a scan runs.")}
          <TextField
            value={envName}
            onChange={setEnvName}
            placeholder="MY_PROVIDER_API_KEY"
            onCancel={props.onCancel}
            onSubmit={(value) => {
              if (!ENV_NAME_PATTERN.test(value.trim())) {
                setError(
                  "Use letters, digits, and underscores, starting with a letter or underscore.",
                );
                return;
              }
              setEnvName(value.trim());
              go("models");
            }}
          />
        </>
      );
      break;
    case "models":
      body = (
        <Text>
          <Spinner /> Listing the endpoint's models…
        </Text>
      );
      break;
    case "model": {
      const choices: Choice<string>[] = [
        ...models.map((id) => ({ value: id, label: id })),
        { value: MANUAL, label: "Enter a model ID by hand" },
        { value: BACK, label: "Back" },
      ];
      body = (
        <>
          {title("Which model?", `${models.length} listed. Type to filter.`)}
          <SelectList
            choices={choices}
            searchable
            limit={modelRows}
            onCancel={props.onCancel}
            onSelect={(value) => {
              if (value === BACK) go("keyMode");
              else if (value === MANUAL) go("modelManual");
              else {
                setModel(value);
                go("name");
              }
            }}
          />
        </>
      );
      break;
    }
    case "modelManual":
      body = (
        <>
          {title(
            "Model ID?",
            modelsNote
              ? `${modelsNote} Enter the ID the endpoint expects.`
              : "The ID the endpoint expects.",
          )}
          <TextField
            value={model}
            onChange={setModel}
            onCancel={props.onCancel}
            onSubmit={(value) => {
              if (value.trim() === "") {
                setError("Enter a model ID.");
                return;
              }
              setModel(value.trim());
              go("name");
            }}
          />
        </>
      );
      break;
    case "name":
      body = (
        <>
          {title("Name for this provider?", "Used in commands and in the fallback order.")}
          <TextField
            value={name}
            onChange={setName}
            placeholder={preset?.id ?? "my-provider"}
            onCancel={props.onCancel}
            onSubmit={(value) => {
              const chosen = value.trim() || preset?.id || "";
              if (!PROVIDER_NAME_PATTERN.test(chosen)) {
                setError(
                  "Names start with a letter or digit and use letters, digits, dots, underscores, and hyphens.",
                );
                return;
              }
              if (taken.has(chosen.toLowerCase())) {
                setError(`A provider named ${chosen} already exists. Choose another name.`);
                return;
              }
              if (chosen.toLowerCase() === ENV_PROVIDER_NAME) {
                setError(`${ENV_PROVIDER_NAME} is reserved. Choose another name.`);
                return;
              }
              setName(chosen);
              go("checking");
            }}
          />
        </>
      );
      break;
    case "checking":
      body = (
        <Text>
          <Spinner /> Sending a test request to {name}…
        </Text>
      );
      break;
    case "review": {
      const provider = draft!;
      const ok = check?.ok === true;
      const choices: Choice<string>[] = [
        {
          value: "save",
          label: ok ? "Add provider" : "Add it anyway",
          hint: props.first ? "as the primary provider" : "as the last fallback",
        },
        { value: "retry", label: "Test again" },
        { value: BACK, label: "Back", hint: "change the answers" },
        { value: "cancel", label: "Cancel" },
      ];
      body = (
        <>
          {title("Add this provider?")}
          <Box flexDirection="column" marginBottom={1}>
            <Row label="Name">{provider.name}</Row>
            <Row label="Base URL">{provider.base_url}</Row>
            <Row label="Model">{provider.model}</Row>
            <Row label="API">{provider.wire_api ?? "chat"}</Row>
            <Row label="Key">
              {keyMode === "paste"
                ? "pasted, stored where scans cannot read it"
                : keyLabel(provider, props.env, props.keys)}
            </Row>
            <Row label="Check">
              {check === undefined ? (
                "not run"
              ) : check.ok ? (
                <>
                  <Tint tone="success">ok</Tint>
                  {` in ${formatDuration(check.latencyMs)}${check.toolCall ? ", tool calling works" : ""}`}
                </>
              ) : (
                <>
                  <Tint tone="danger">failed</Tint>
                  {` ${check.failure?.message ?? ""}`}
                </>
              )}
            </Row>
          </Box>
          {check?.failure?.kind === "bad_request" ? (
            <Box marginBottom={1} flexDirection="column">
              <Text>
                <Tint tone="warning">! </Tint>
                {`The endpoint rejected the test request. If it does not accept effort ${scanEffort}, add it anyway and set its own:`}
              </Text>
              <Text>
                {"    "}
                <Tint tone="command">{`${BIN} providers update ${provider.name} --effort <VALUE>`}</Tint>
              </Text>
            </Box>
          ) : null}
          {check?.ok && !check.toolCall ? (
            <Box marginBottom={1}>
              <Tint tone="warning">! </Tint>
              <Text>
                The model answered without calling the probe tool. Scans depend on tool calls.
              </Text>
            </Box>
          ) : null}
          <SelectList
            choices={choices}
            initialIndex={ok ? 0 : 1}
            onCancel={props.onCancel}
            onSelect={(value) => {
              if (value === "save") go("saving");
              else if (value === "retry") go("checking");
              else if (value === BACK) go("preset");
              else props.onCancel();
            }}
          />
        </>
      );
      break;
    }
    case "saving":
      body = (
        <Text>
          <Spinner /> Saving…
        </Text>
      );
      break;
  }

  const textStep = ["baseUrl", "keyValue", "envName", "modelManual", "name"].includes(step);
  return (
    <Box flexDirection="column">
      {answered.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {answered.map(([label, value]) => (
            <Row key={label} label={label}>
              {value}
            </Row>
          ))}
        </Box>
      ) : null}
      {body}
      {problem}
      <Box marginTop={1}>
        <KeyHints
          hints={
            textStep
              ? [
                  { keys: "Enter", label: "continue" },
                  { keys: "Esc", label: "cancel" },
                ]
              : step === "models" || step === "checking" || step === "saving"
                ? [{ keys: "Esc", label: "cancel" }]
                : [
                    { keys: "↑↓", label: "move" },
                    { keys: "Enter", label: "select" },
                    { keys: "Esc", label: "cancel" },
                  ]
          }
        />
      </Box>
    </Box>
  );
}

export async function saveProvider(
  context: Pick<AppContext, "paths">,
  provider: ProviderConfig,
  apiKey: string | undefined,
  first: boolean,
): Promise<{ position: number; total: number }> {
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
  const providers = saved.providers ?? [];
  return {
    position: providers.findIndex((item) => item.name === provider.name) + 1,
    total: providers.length,
  };
}

export function replayCommand(result: WizardResult): string[] {
  const { provider } = result;
  const argv = [
    BIN,
    "providers",
    "add",
    provider.name,
    "--base-url",
    provider.base_url,
    "--model",
    provider.model,
    "--wire-api",
    provider.wire_api ?? "chat",
  ];
  if (result.keyMode === "env" && provider.api_key_env)
    argv.push("--api-key-env", provider.api_key_env);
  if (result.keyMode === "paste") argv.push("--api-key-stdin");
  for (const [header, value] of Object.entries(provider.headers ?? {}))
    argv.push("--header", `${header}=${value}`);
  return argv;
}

export async function runProviderWizard(
  context: AppContext,
  options: { name: string | undefined; first: boolean },
): Promise<number> {
  const { output, terminal, env } = context;
  const config = await loadUserConfig(context);
  const keys = await loadKeys(context);
  const result = await new Promise<WizardResult | null>((resolvePromise) => {
    const instance = render(
      <ColorProvider color={terminal.stderrColor}>
        <ProviderWizard
          env={env}
          config={config}
          keys={keys}
          first={options.first}
          initialName={options.name}
          signal={context.signal}
          save={(provider, apiKey) => saveProvider(context, provider, apiKey, options.first)}
          onDone={(done) => {
            instance.clear();
            instance.unmount();
            resolvePromise(done);
          }}
          onCancel={() => {
            instance.clear();
            instance.unmount();
            resolvePromise(null);
          }}
        />
      </ColorProvider>,
      { stdout: process.stderr, stdin: process.stdin, exitOnCtrlC: true, patchConsole: false },
    );
    void instance.waitUntilExit().then(
      () => resolvePromise(null),
      () => resolvePromise(null),
    );
  });
  if (result === null) throw new CanceledError("No provider was added.");

  const { provider, check } = result;
  output.success("Added", provider.name);
  output.row("Model", provider.model);
  output.row("API", provider.wire_api ?? "chat");
  output.row("Base URL", provider.base_url);
  output.row("Key", keyLabel(provider, env, await loadKeys(context)));
  output.row("Position", `${result.position} of ${result.total}`);
  if (check)
    output.row(
      "Check",
      check.ok
        ? `ok in ${formatDuration(check.latencyMs)}${check.toolCall ? " (tool calling works)" : ""}`
        : `failed: ${check.failure?.message ?? ""}`,
    );
  output.info();
  output.info("  Run this again without prompts:");
  output.info(`    ${formatCommand(replayCommand(result))}`);
  output.next([{ label: "Scan a repository", argv: [BIN, "scan"] }]);
  return 0;
}
