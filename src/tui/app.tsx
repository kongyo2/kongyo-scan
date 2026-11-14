import { basename } from "node:path";

import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { AppContext } from "../app/context.js";
import { loadKeys, loadUserConfig } from "../app/context.js";
import { formatAge, formatDuration, formatTokens, formatUsd, plural } from "../cli/format.js";
import { type DoctorCheck, runDoctorChecks } from "../commands/doctor.js";
import { keyLabel } from "../commands/providers.js";
import { deleteProviderKey, type StoredKeys } from "../config/credentials.js";
import { getValue, setValue, unsetValue } from "../config/keys.js";
import { type Config, DEFAULT_REASONING_EFFORT, type ProviderConfig } from "../config/schema.js";
import { loadConfigFile, saveConfigFile, updateConfigFile } from "../config/store.js";
import { CanceledError, CliError, describeError } from "../core/errors.js";
import { displayPath } from "../core/paths.js";
import { type CheckResult, checkProvider } from "../providers/check.js";
import { availableProviders, resolveProvider } from "../providers/resolve.js";
import {
  describeTarget,
  type HistoryRecord,
  readHistory,
  type TargetDescription,
} from "../scan/history.js";
import {
  anchorConfigPaths,
  resolveScanPlan,
  type ScanCliOptions,
  type ScanPlan,
} from "../scan/plan.js";
import {
  countSeverities,
  type FindingSummary,
  formatCounts,
  readScanFindings,
} from "../scan/results.js";
import { runScan, type ScanOutcome } from "../scan/runner.js";
import { BIN, VERSION } from "../version.js";
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
} from "./components.js";
import { FindingsView } from "./findings-view.js";
import { ProviderWizard, saveProvider } from "./provider-wizard.js";
import {
  initialScanViewState,
  reduceScanEvent,
  ScanView,
  type ScanViewState,
} from "./scan-view.js";

type Screen =
  | { name: "home" }
  | { name: "scanSetup" }
  | { name: "scanning"; plan: ScanPlan }
  | { name: "result"; outcome: ScanOutcome }
  | { name: "failure"; title: string; error: CliError | CanceledError | Error }
  | { name: "history" }
  | { name: "historyDetail"; record: HistoryRecord; findings: FindingSummary[] }
  | { name: "providers" }
  | { name: "providerAdd" }
  | { name: "settings" }
  | { name: "doctor" };

interface Loaded {
  config: Config;
  keys: StoredKeys;
  history: HistoryRecord[];
}

function Frame(props: { context: AppContext; title: string; children: ReactNode }): ReactNode {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexShrink={0}>
          <Text>
            <Tint tone="accent" bold>
              {BIN}
            </Tint>
            <Faint> {VERSION}</Faint>
            <Text bold>{`  ${props.title}`}</Text>
          </Text>
        </Box>
        {/* A long path gives way to the title: it loses its start, never the directory name. */}
        <Box flexShrink={1} marginLeft={2}>
          <Text wrap="truncate-start">
            <Faint>{displayPath(props.context.cwd, props.context.env)}</Faint>
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {props.children}
      </Box>
    </Box>
  );
}

function ErrorBlock(props: { error: unknown }): ReactNode {
  const { error } = props;
  if (error instanceof CanceledError) {
    return (
      <Text>
        Canceled. <Faint>{error.summary}</Faint>
      </Text>
    );
  }
  const message = error instanceof CliError ? error.message : describeError(error);
  const cli = error instanceof CliError ? error : undefined;
  return (
    <Box flexDirection="column">
      <Text>
        <Tint tone="danger">✗ </Tint>
        {message}
      </Text>
      {cli?.details.slice(0, 5).map((detail) => (
        <Text key={detail}>{`  ${detail}`}</Text>
      ))}
      {cli?.rows.map(([label, value]) => (
        <Row key={`${label}:${value}`} label={`  ${label}`} width={18}>
          {value}
        </Row>
      ))}
      {cli?.hint ? <Text>{`  ${cli.hint}`}</Text> : null}
      {cli?.next.slice(0, 2).map((step) => (
        <Box key={step.label} flexDirection="column" marginTop={1}>
          <Text>{`  ${step.label}:`}</Text>
          <Text>
            {"    "}
            <Tint tone="command">{step.argv.join(" ")}</Tint>
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Home

type HomeAction =
  | "scan"
  | "scanSetup"
  | "history"
  | "providers"
  | "providerAdd"
  | "settings"
  | "doctor"
  | "quit";

function Home(props: {
  context: AppContext;
  loaded: Loaded;
  onAction: (action: HomeAction) => void;
  notice: string | undefined;
}): ReactNode {
  const { config, history } = props.loaded;
  const providers = availableProviders(config, props.context.env).filter(
    (provider) => provider.disabled !== true,
  );
  const hasProvider = providers.length > 0;
  const latest = history[0];
  const choices: Choice<HomeAction>[] = hasProvider
    ? [
        {
          value: "scan",
          label: "Scan this repository",
          hint: `${basename(props.context.cwd) || props.context.cwd}, whole repository`,
        },
        {
          value: "scanSetup",
          label: "Scan with options",
          hint: "paths, Git changes, or a deep scan",
        },
      ]
    : [
        {
          value: "providerAdd",
          label: "Add a model provider",
          hint: "needed before the first scan",
        },
      ];
  choices.push(
    {
      value: "history",
      label: "Past scans",
      hint: latest
        ? `${plural(history.length, "scan")}, latest ${formatAge(latest.startedAt)} ago`
        : "none yet",
    },
    {
      value: "providers",
      label: "Providers",
      hint: hasProvider
        ? providers.map((provider) => provider.name).join(" → ")
        : "none configured",
    },
    {
      value: "settings",
      label: "Settings",
      hint: `effort ${config.reasoning_effort ?? DEFAULT_REASONING_EFFORT}, ${config.scan?.mode ?? "standard"} scans`,
    },
    { value: "doctor", label: "Check this machine" },
    { value: "quit", label: "Quit" },
  );
  return (
    <Frame context={props.context} title="">
      <Faint>Codex Security scans on your own model endpoints, with fallback.</Faint>
      {props.notice ? (
        <Box marginTop={1}>
          <Tint tone="success">✓ </Tint>
          <Text>{props.notice}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <SelectList
          choices={choices}
          limit={10}
          onSelect={props.onAction}
          onCancel={() => props.onAction("quit")}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { keys: "↑↓", label: "move" },
            { keys: "Enter", label: "select" },
            { keys: "Esc", label: "quit" },
          ]}
        />
      </Box>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Scan setup

type ScopeKind = TargetDescription["kind"];
type SetupStep = "scope" | "paths" | "base" | "mode" | "review";

function ScanSetup(props: {
  context: AppContext;
  loaded: Loaded;
  onStart: (cli: ScanCliOptions) => void;
  onBack: () => void;
  error: string | undefined;
}): ReactNode {
  const [step, setStep] = useState<SetupStep>("scope");
  const [scope, setScope] = useState<ScopeKind>("repository");
  const [paths, setPaths] = useState("");
  const [base, setBase] = useState("");
  const [mode, setMode] = useState<"standard" | "deep">(
    props.loaded.config.scan?.mode ?? "standard",
  );
  const [problem, setProblem] = useState<string | undefined>(props.error);
  const go = (next: SetupStep): void => {
    setProblem(undefined);
    setStep(next);
  };
  const deepAllowed = scope === "repository" || scope === "paths";
  const cli = (): ScanCliOptions => {
    const options: ScanCliOptions = { mode: deepAllowed ? mode : "standard" };
    if (scope === "paths")
      options.paths = paths
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    else if (scope === "diff") options.diff = base.trim();
    else if (scope === "working_tree") {
      options.workingTree = true;
      if (base.trim() !== "") options.base = base.trim();
    }
    return options;
  };
  const scopeText =
    scope === "paths"
      ? paths
      : scope === "diff"
        ? `changes since ${base}`
        : scope === "working_tree"
          ? `uncommitted changes${base ? ` against ${base}` : ""}`
          : "whole repository";

  let body: ReactNode;
  if (step === "scope") {
    body = (
      <>
        <Text bold>What should be scanned?</Text>
        <Box marginTop={1}>
          <SelectList<ScopeKind | "back">
            choices={[
              { value: "repository", label: "The whole repository" },
              { value: "paths", label: "Selected paths", hint: "files or directories" },
              {
                value: "diff",
                label: "Committed changes since a revision",
                hint: "such as origin/main",
              },
              { value: "working_tree", label: "Uncommitted changes", hint: "staged and unstaged" },
              { value: "back", label: "Back" },
            ]}
            onCancel={props.onBack}
            onSelect={(value) => {
              if (value === "back") props.onBack();
              else {
                setScope(value);
                go(
                  value === "paths"
                    ? "paths"
                    : value === "diff"
                      ? "base"
                      : value === "working_tree"
                        ? "review"
                        : "mode",
                );
              }
            }}
          />
        </Box>
      </>
    );
  } else if (step === "paths") {
    body = (
      <>
        <Text bold>Which paths?</Text>
        <Faint>Relative to the repository, separated by commas.</Faint>
        <Box marginTop={1}>
          <TextField
            value={paths}
            onChange={setPaths}
            placeholder="src, tests"
            onCancel={props.onBack}
            onSubmit={(value) => {
              if (value.split(",").every((item) => item.trim() === ""))
                setProblem("Enter at least one path.");
              else go("mode");
            }}
          />
        </Box>
      </>
    );
  } else if (step === "base") {
    body = (
      <>
        <Text bold>Since which revision?</Text>
        <Faint>A branch, tag, or commit. The scan covers committed changes from it to HEAD.</Faint>
        <Box marginTop={1}>
          <TextField
            value={base}
            onChange={setBase}
            placeholder="origin/main"
            onCancel={props.onBack}
            onSubmit={(value) => {
              if (value.trim() === "") setProblem("Enter a revision.");
              else go("review");
            }}
          />
        </Box>
      </>
    );
  } else if (step === "mode") {
    body = (
      <>
        <Text bold>Which kind of scan?</Text>
        <Box marginTop={1}>
          <SelectList<"standard" | "deep" | "back">
            choices={[
              { value: "standard", label: "Standard", hint: "one pass; minutes" },
              {
                value: "deep",
                label: "Deep",
                hint: "repeated passes that merge findings; much longer and costlier",
              },
              { value: "back", label: "Back" },
            ]}
            initialIndex={mode === "deep" ? 1 : 0}
            onCancel={props.onBack}
            onSelect={(value) => {
              if (value === "back") go("scope");
              else {
                setMode(value);
                go("review");
              }
            }}
          />
        </Box>
      </>
    );
  } else {
    const chain = availableProviders(props.loaded.config, props.context.env).filter(
      (provider) => provider.disabled !== true,
    );
    body = (
      <>
        <Text bold>Start this scan?</Text>
        <Box flexDirection="column" marginY={1}>
          <Row label="Repository">{props.context.cwd}</Row>
          <Row label="Scope">{scopeText}</Row>
          <Row label="Mode">{deepAllowed ? mode : "standard"}</Row>
          <Row label="Providers">
            {chain.map((provider) => `${provider.name} (${provider.model})`).join(" → ")}
          </Row>
          <Row label="Effort">
            {props.loaded.config.reasoning_effort ?? DEFAULT_REASONING_EFFORT}
          </Row>
        </Box>
        <SelectList<"start" | "back" | "cancel">
          choices={[
            { value: "start", label: "Start the scan" },
            { value: "back", label: "Back", hint: "change the answers" },
            { value: "cancel", label: "Cancel" },
          ]}
          onCancel={props.onBack}
          onSelect={(value) => {
            if (value === "start") props.onStart(cli());
            else if (value === "back") go("scope");
            else props.onBack();
          }}
        />
      </>
    );
  }
  return (
    <Frame context={props.context} title="New scan">
      {body}
      {problem ? (
        <Box marginTop={1}>
          <Tint tone="danger">✗ </Tint>
          <Text>{problem}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints
          hints={
            step === "paths" || step === "base"
              ? [
                  { keys: "Enter", label: "continue" },
                  { keys: "Esc", label: "cancel" },
                ]
              : [
                  { keys: "↑↓", label: "move" },
                  { keys: "Enter", label: "select" },
                  { keys: "Esc", label: "cancel" },
                ]
          }
        />
      </Box>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Running scan

/** Work that has to finish before the process exits, such as stopping a running scan cleanly. */
const pendingWork = new Set<Promise<void>>();

function Scanning(props: {
  context: AppContext;
  plan: ScanPlan;
  onDone: (outcome: ScanOutcome) => void;
  onError: (error: unknown) => void;
}): ReactNode {
  const [state, setState] = useState<ScanViewState>(initialScanViewState);
  const [stopping, setStopping] = useState(false);
  const controller = useRef(new AbortController());
  const startedAt = useRef(Date.now());
  const { columns } = useWindowSize();

  useEffect(() => {
    let active = true;
    const abort = controller.current;
    const onParentAbort = (): void => abort.abort();
    props.context.signal.addEventListener("abort", onParentAbort, { once: true });
    const scan = async (): Promise<void> => {
      let outcome: ScanOutcome;
      try {
        outcome = await runScan(props.plan, props.context.paths, {
          signal: abort.signal,
          onEvent: (event) => {
            if (active) setState((current) => reduceScanEvent(current, event));
          },
        });
      } catch (error) {
        if (active) props.onError(error);
        return;
      }
      if (active) props.onDone(outcome);
    };
    // Leaving the app stops the scan; the process waits for that to finish before it exits.
    const task = scan();
    pendingWork.add(task);
    void task.finally(() => pendingWork.delete(task));
    return () => {
      active = false;
      props.context.signal.removeEventListener("abort", onParentAbort);
      abort.abort();
    };
  }, []);

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || key.escape) {
      if (stopping) return;
      setStopping(true);
      controller.current.abort(new CanceledError());
    }
  });

  return (
    <Frame context={props.context} title="Scan">
      <ScanView
        plan={props.plan}
        state={state}
        startedAt={startedAt.current}
        columns={columns - 2}
        footer={
          stopping ? (
            <Text>Stopping the scan…</Text>
          ) : (
            <KeyHints hints={[{ keys: "Esc", label: "stop the scan" }]} />
          )
        }
      />
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// History

function History(props: {
  context: AppContext;
  loaded: Loaded;
  onOpen: (record: HistoryRecord) => void;
  onBack: () => void;
  error: string | undefined;
}): ReactNode {
  const { history } = props.loaded;
  const { rows } = useWindowSize();
  const choices: Choice<string>[] = history.map((record) => ({
    value: record.scanId,
    label: `${formatAge(record.startedAt).padEnd(12)} ${record.status.padEnd(11)} ${(record.status === "completed" ? (record.findingCount === 0 ? "no findings" : formatCounts(record.findings ?? countSeverities([]))) : "-").padEnd(20)}`,
    hint: `${describeTarget(record.target)} · ${displayPath(record.repository, props.context.env)}`,
  }));
  return (
    <Frame context={props.context} title="Past scans">
      {history.length === 0 ? (
        <Faint>No scans yet. Run one from the home screen.</Faint>
      ) : (
        <>
          <Faint>{`${"Age".padEnd(14)} ${"Status".padEnd(11)} Findings`}</Faint>
          <SelectList
            choices={choices}
            limit={Math.max(5, rows - 9)}
            onCancel={props.onBack}
            onSelect={(scanId) => {
              const record = history.find((item) => item.scanId === scanId);
              if (record) props.onOpen(record);
            }}
          />
        </>
      )}
      {props.error ? (
        <Box marginTop={1}>
          <Tint tone="danger">✗ </Tint>
          <Text>{props.error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(history.length > 0
              ? [
                  { keys: "↑↓", label: "move" },
                  { keys: "Enter", label: "open" },
                ]
              : []),
            { keys: "Esc", label: "back" },
          ]}
        />
      </Box>
      {history.length === 0 ? <BackOnEscape onBack={props.onBack} /> : null}
    </Frame>
  );
}

function BackOnEscape(props: { onBack: () => void }): ReactNode {
  useInput((input, key) => {
    if (key.escape || input === "b" || key.return) props.onBack();
  });
  return null;
}

// ---------------------------------------------------------------------------
// Providers

type ProviderMode =
  | { kind: "list" }
  | { kind: "confirmRemove"; name: string }
  | { kind: "model"; name: string; value: string }
  | { kind: "busy"; label: string };

function Providers(props: {
  context: AppContext;
  loaded: Loaded;
  reload: () => Promise<void>;
  onAdd: () => void;
  onBack: () => void;
}): ReactNode {
  const { context } = props;
  const providers = props.loaded.config.providers ?? [];
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<ProviderMode>({ kind: "list" });
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const [message, setMessage] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const focused = providers[Math.min(index, providers.length - 1)];

  const mutate = (label: string, change: (config: Config) => void, done: string): void => {
    setMode({ kind: "busy", label });
    setProblem(undefined);
    void (async () => {
      try {
        await updateConfigFile(context.paths.configFile, change);
        await props.reload();
        setMessage(done);
      } catch (error) {
        setProblem(error instanceof CliError ? error.message : describeError(error));
      }
      setMode({ kind: "list" });
    })();
  };

  const move = (delta: number): void => {
    if (!focused) return;
    const target = index + delta;
    if (target < 0 || target >= providers.length) return;
    mutate(
      "Reordering…",
      (config) => {
        const list = [...(config.providers ?? [])];
        const from = list.findIndex((item) => item.name === focused.name);
        if (from < 0) return;
        const [moved] = list.splice(from, 1);
        list.splice(from + delta, 0, moved!);
        config.providers = list;
      },
      `Moved ${focused.name} to position ${target + 1}.`,
    );
    setIndex(target);
  };

  const test = (provider: ProviderConfig): void => {
    setMode({ kind: "busy", label: `Testing ${provider.name}…` });
    setProblem(undefined);
    void (async () => {
      // A failed check is a result, not a rejection.
      const result = await checkProvider(
        resolveProvider(provider, context.env, props.loaded.keys),
        {
          signal: context.signal,
          effort: provider.reasoning_effort ?? props.loaded.config.reasoning_effort,
        },
      );
      setChecks((current) => ({ ...current, [provider.name]: result }));
      setMessage(undefined);
      setMode({ kind: "list" });
    })();
  };

  useInput(
    (input, key) => {
      if (mode.kind === "confirmRemove") {
        if (input === "y" || input === "Y") {
          const name = mode.name;
          setMode({ kind: "busy", label: "Removing…" });
          void (async () => {
            try {
              await updateConfigFile(context.paths.configFile, (config) => {
                config.providers = (config.providers ?? []).filter((item) => item.name !== name);
              });
              await deleteProviderKey(context.paths.credentialsFile, name);
              await props.reload();
              setMessage(`Removed ${name}.`);
              setIndex(0);
            } catch (error) {
              setProblem(describeError(error));
            }
            setMode({ kind: "list" });
          })();
        } else setMode({ kind: "list" });
        return;
      }
      if (key.escape || input === "b") props.onBack();
      else if (input === "a") props.onAdd();
      else if (key.upArrow || input === "k") setIndex((current) => Math.max(0, current - 1));
      else if (key.downArrow || input === "j")
        setIndex((current) => Math.min(providers.length - 1, current + 1));
      else if (!focused) return;
      else if (input === "t") test(focused);
      else if (input === "u") move(-1);
      else if (input === "d") move(1);
      else if (input === "m") setMode({ kind: "model", name: focused.name, value: focused.model });
      else if (input === "x") setMode({ kind: "confirmRemove", name: focused.name });
      else if (input === " ") {
        const disable = focused.disabled !== true;
        mutate(
          disable ? "Disabling…" : "Enabling…",
          (config) => {
            config.providers = (config.providers ?? []).map((item) => {
              if (item.name !== focused.name) return item;
              const next = { ...item };
              if (disable) next.disabled = true;
              else delete next.disabled;
              return next;
            });
          },
          `${disable ? "Disabled" : "Enabled"} ${focused.name}.`,
        );
      }
    },
    { isActive: mode.kind === "list" || mode.kind === "confirmRemove" },
  );

  const firstEnabled = providers.findIndex((provider) => provider.disabled !== true);
  const nameWidth = Math.max(8, ...providers.map((provider) => provider.name.length));
  const modelWidth = Math.max(8, ...providers.map((provider) => provider.model.length));
  return (
    <Frame context={context} title="Providers">
      <Faint>Requests go to the first provider; the others are tried in order when it fails.</Faint>
      <Box flexDirection="column" marginTop={1}>
        {providers.length === 0 ? (
          <Faint>No providers configured. Press a to add one.</Faint>
        ) : null}
        {providers.map((provider, position) => {
          const active = position === index;
          const check = checks[provider.name];
          return (
            <Box key={provider.name} flexDirection="column">
              <Text wrap="truncate-end">
                {active ? <Tint tone="accent">› </Tint> : "  "}
                <Faint>{`${position + 1}  `}</Faint>
                <Text bold={active}>{provider.name.padEnd(nameWidth)}</Text>
                {`  ${provider.model.padEnd(modelWidth)}  ${(provider.wire_api ?? "chat").padEnd(9)}  `}
                <Faint>{keyLabel(provider, context.env, props.loaded.keys)}</Faint>
                {"  "}
                {provider.disabled ? (
                  <Tint tone="warning">disabled</Tint>
                ) : position === firstEnabled ? (
                  <Tint tone="success">primary</Tint>
                ) : (
                  <Faint>fallback</Faint>
                )}
              </Text>
              {check ? (
                <Text wrap="truncate-end">
                  {"       "}
                  {check.ok ? <Tint tone="success">ok</Tint> : <Tint tone="danger">failed</Tint>}
                  <Faint>
                    {check.ok
                      ? ` in ${formatDuration(check.latencyMs)}${check.toolCall ? ", tool calling works" : ", but the probe tool was not called"}`
                      : ` ${check.failure?.message ?? ""}`}
                  </Faint>
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {mode.kind === "busy" ? (
          <Text>
            <Spinner /> {mode.label}
          </Text>
        ) : mode.kind === "confirmRemove" ? (
          <Text>
            Remove provider <Text bold>{mode.name}</Text> and its stored key?{" "}
            <Text bold>(y/N)</Text>
          </Text>
        ) : mode.kind === "model" ? (
          <Box>
            <Text>Model for {mode.name}: </Text>
            <TextField
              value={mode.value}
              onChange={(value) => setMode({ ...mode, value })}
              onCancel={() => setMode({ kind: "list" })}
              onSubmit={(value) => {
                const model = value.trim();
                const name = mode.name;
                if (model === "") {
                  setMode({ kind: "list" });
                  return;
                }
                mutate(
                  "Saving…",
                  (config) => {
                    config.providers = (config.providers ?? []).map((item) =>
                      item.name === name ? { ...item, model } : item,
                    );
                  },
                  `${name} now uses ${model}.`,
                );
              }}
            />
          </Box>
        ) : message ? (
          <Text>
            <Tint tone="success">✓ </Tint>
            {message}
          </Text>
        ) : null}
        {problem ? (
          <Text>
            <Tint tone="danger">✗ </Tint>
            {problem}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={
            mode.kind === "model"
              ? [
                  { keys: "Enter", label: "save" },
                  { keys: "Esc", label: "cancel" },
                ]
              : [
                  { keys: "a", label: "add" },
                  ...(focused
                    ? [
                        { keys: "t", label: "test" },
                        { keys: "m", label: "model" },
                        { keys: "u/d", label: "move up/down" },
                        { keys: "Space", label: focused.disabled ? "enable" : "disable" },
                        { keys: "x", label: "remove" },
                      ]
                    : []),
                  { keys: "Esc", label: "back" },
                ]
          }
        />
      </Box>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Settings

interface SettingField {
  key: string;
  label: string;
  hint: string;
  /** Fixed choices; free text when absent. An empty string choice clears the setting. */
  choices?: readonly { value: string; label: string }[];
  fallback: string;
}

const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: "reasoning_effort",
    label: "Reasoning effort",
    hint: 'Passed to the model: low, medium, high, xhigh, max, or "default" to send none.',
    fallback: DEFAULT_REASONING_EFFORT,
  },
  {
    key: "scan.mode",
    label: "Scan mode",
    hint: "Standard is one pass. Deep repeats passes and merges findings.",
    choices: [
      { value: "standard", label: "standard" },
      { value: "deep", label: "deep" },
    ],
    fallback: "standard",
  },
  {
    key: "policy.fail_on_severity",
    label: "Fail on severity",
    hint: "Exit code 1 when a finding at or above this level is reported.",
    choices: [
      { value: "", label: "off (report only)" },
      { value: "critical", label: "critical" },
      { value: "high", label: "high" },
      { value: "medium", label: "medium" },
      { value: "low", label: "low" },
    ],
    fallback: "off",
  },
  {
    key: "scan.max_time_minutes",
    label: "Time allowance",
    hint: "Investigation minutes. Advisory for standard scans, enforced for deep discovery. Empty clears it.",
    fallback: "none",
  },
  {
    key: "limits.max_cost_usd_per_scan",
    label: "Cost limit (USD)",
    hint: "Stop a scan past this estimated cost. Needs pricing on every provider. Empty clears it.",
    fallback: "none",
  },
];

function Settings(props: {
  context: AppContext;
  loaded: Loaded;
  reload: () => Promise<void>;
  onBack: () => void;
}): ReactNode {
  const { context } = props;
  const [editing, setEditing] = useState<{ field: SettingField; value: string } | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  const apply = (field: SettingField, raw: string): void => {
    setProblem(undefined);
    void (async () => {
      try {
        const { config } = await loadConfigFile(context.paths.configFile);
        const next =
          raw.trim() === ""
            ? unsetValue(config, field.key, context.paths.configFile).config
            : setValue(config, field.key, raw.trim(), context.paths.configFile);
        await saveConfigFile(context.paths.configFile, next);
        await props.reload();
        setMessage(
          raw.trim() === ""
            ? `Cleared ${field.label.toLowerCase()}.`
            : `${field.label} is now ${raw.trim()}.`,
        );
      } catch (error) {
        setProblem(error instanceof CliError ? error.message : describeError(error));
      }
      setEditing(undefined);
    })();
  };

  const current = (field: SettingField): string => {
    const value = getValue(props.loaded.config, field.key);
    return value === undefined ? field.fallback : String(value);
  };

  let body: ReactNode;
  if (editing?.field.choices) {
    const field = editing.field;
    body = (
      <>
        <Text bold>{field.label}</Text>
        <Faint>{field.hint}</Faint>
        <Box marginTop={1}>
          <SelectList
            choices={field.choices!.map((choice) => ({ value: choice.value, label: choice.label }))}
            initialIndex={Math.max(
              0,
              field.choices!.findIndex(
                (choice) => choice.value === String(getValue(props.loaded.config, field.key) ?? ""),
              ),
            )}
            onCancel={() => setEditing(undefined)}
            onSelect={(value) => apply(field, value)}
          />
        </Box>
      </>
    );
  } else if (editing) {
    const field = editing.field;
    body = (
      <>
        <Text bold>{field.label}</Text>
        <Faint>{field.hint}</Faint>
        <Box marginTop={1}>
          <TextField
            value={editing.value}
            onChange={(value) => setEditing({ field, value })}
            onCancel={() => setEditing(undefined)}
            onSubmit={(value) => apply(field, value)}
          />
        </Box>
      </>
    );
  } else {
    body = (
      <>
        <SelectList<string>
          choices={[
            ...SETTING_FIELDS.map((field) => ({
              value: field.key,
              label: field.label.padEnd(20),
              hint: current(field),
            })),
            { value: "__back__", label: "Back" },
          ]}
          onCancel={props.onBack}
          onSelect={(key) => {
            if (key === "__back__") {
              props.onBack();
              return;
            }
            const field = SETTING_FIELDS.find((item) => item.key === key)!;
            const value = getValue(props.loaded.config, field.key);
            setMessage(undefined);
            setEditing({ field, value: value === undefined ? "" : String(value) });
          }}
        />
        <Box flexDirection="column" marginTop={1}>
          <Faint>{`More settings: ${BIN} config keys`}</Faint>
          <Faint>{displayPath(context.paths.configFile, context.env)}</Faint>
        </Box>
      </>
    );
  }
  return (
    <Frame context={context} title="Settings">
      {body}
      {message ? (
        <Box marginTop={1}>
          <Tint tone="success">✓ </Tint>
          <Text>{message}</Text>
        </Box>
      ) : null}
      {problem ? (
        <Box marginTop={1}>
          <Tint tone="danger">✗ </Tint>
          <Text>{problem}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints
          hints={
            editing && !editing.field.choices
              ? [
                  { keys: "Enter", label: "save" },
                  { keys: "Esc", label: "cancel" },
                ]
              : [
                  { keys: "↑↓", label: "move" },
                  { keys: "Enter", label: editing ? "choose" : "change" },
                  { keys: "Esc", label: editing ? "cancel" : "back" },
                ]
          }
        />
      </Box>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Doctor

function Doctor(props: { context: AppContext; onBack: () => void }): ReactNode {
  const [checks, setChecks] = useState<DoctorCheck[] | undefined>();
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await runDoctorChecks(props.context);
      if (active) setChecks(result);
    })();
    return () => {
      active = false;
    };
  }, []);
  useInput((input, key) => {
    if (key.escape || key.return || input === "b") props.onBack();
  });
  return (
    <Frame context={props.context} title="Check this machine">
      {checks === undefined ? (
        <Text>
          <Spinner /> Checking…
        </Text>
      ) : (
        checks.map((check) => (
          <Box key={check.name} flexDirection="column">
            <Box>
              <Box width={18} flexShrink={0}>
                <Text>
                  {check.status === "ok" ? (
                    <Tint tone="success">✓ </Tint>
                  ) : check.status === "warning" ? (
                    <Tint tone="warning">! </Tint>
                  ) : (
                    <Tint tone="danger">✗ </Tint>
                  )}
                  {check.name}
                </Text>
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                <Text>{check.detail}</Text>
                {check.fix ? <Faint>{check.fix}</Faint> : null}
              </Box>
            </Box>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <KeyHints hints={[{ keys: "Enter", label: "back" }]} />
      </Box>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// App

function App(props: { context: AppContext; onInterrupt: () => void }): ReactNode {
  const { context } = props;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [loadError, setLoadError] = useState<unknown>();
  const [notice, setNotice] = useState<string | undefined>();
  const [setupError, setSetupError] = useState<string | undefined>();
  const [historyError, setHistoryError] = useState<string | undefined>();

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [config, keys, history] = await Promise.all([
        loadUserConfig(context),
        loadKeys(context),
        readHistory(context.paths.historyFile),
      ]);
      setLoaded({ config, keys, history });
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error);
    }
  }, [context]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Ctrl+C leaves the app from any screen except a running scan, which stops the scan first.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        props.onInterrupt();
        exit();
      }
    },
    { isActive: screen.name !== "scanning" },
  );
  useEffect(() => {
    const onAbort = (): void => exit();
    context.signal.addEventListener("abort", onAbort, { once: true });
    return () => context.signal.removeEventListener("abort", onAbort);
  }, [context.signal, exit]);

  const home = (message?: string): void => {
    setNotice(message);
    setScreen({ name: "home" });
  };

  const startScan = (cli: ScanCliOptions): void => {
    if (!loaded) return;
    try {
      const config = anchorConfigPaths(loaded.config, context.paths.configFile, context.env);
      const plan = resolveScanPlan({
        cli,
        config,
        cwd: context.cwd,
        env: context.env,
        keys: loaded.keys,
      });
      setSetupError(undefined);
      setScreen({ name: "scanning", plan });
    } catch (error) {
      setSetupError(error instanceof CliError ? error.message : describeError(error));
      setScreen({ name: "scanSetup" });
    }
  };

  if (loadError !== undefined) {
    return (
      <Frame context={context} title="">
        <ErrorBlock error={loadError} />
        <Box marginTop={1}>
          <KeyHints hints={[{ keys: "Ctrl+C", label: "quit" }]} />
        </Box>
      </Frame>
    );
  }
  if (!loaded) {
    return (
      <Frame context={context} title="">
        <Text>
          <Spinner /> Loading…
        </Text>
      </Frame>
    );
  }

  switch (screen.name) {
    case "home":
      return (
        <Home
          context={context}
          loaded={loaded}
          notice={notice}
          onAction={(action) => {
            setNotice(undefined);
            if (action === "quit") exit();
            else if (action === "scan") startScan({});
            else {
              setSetupError(undefined);
              setHistoryError(undefined);
              setScreen({ name: action } as Screen);
            }
          }}
        />
      );
    case "scanSetup":
      return (
        <ScanSetup
          context={context}
          loaded={loaded}
          error={setupError}
          onStart={startScan}
          onBack={() => home()}
        />
      );
    case "scanning":
      return (
        <Scanning
          context={context}
          plan={screen.plan}
          onDone={(outcome) => {
            void reload();
            setScreen({ name: "result", outcome });
          }}
          onError={(error) => {
            void reload();
            setScreen({
              name: "failure",
              title: "Scan",
              error: error instanceof Error ? error : new Error(String(error)),
            });
          }}
        />
      );
    case "result": {
      const { outcome } = screen;
      const total = outcome.findings.length;
      return (
        <Frame context={context} title="Scan results">
          <FindingsView
            heading={
              <Text>
                <Tint tone="success">✓ </Tint>
                <Text bold>Scan complete</Text>
                {`  ${total === 0 ? "No findings" : `${plural(total, "finding")} (${formatCounts(outcome.counts)})`}`}
                {outcome.policy.breached ? (
                  <Tint tone="warning">{`  ! at or above ${outcome.policy.failOnSeverity}`}</Tint>
                ) : null}
              </Text>
            }
            facts={[
              ["Report", outcome.reportPath],
              [
                "Duration",
                `${formatDuration(outcome.durationMs)}  ·  ${formatTokens(outcome.usage.total)}${outcome.usage.costUsd !== null ? `  ·  ${formatUsd(outcome.usage.costUsd)}` : ""}`,
              ],
              ["Providers", outcome.providers.join(", ") || outcome.model],
            ]}
            findings={outcome.findings}
            columns={columns - 2}
            rows={rows}
            onBack={() => home()}
          />
        </Frame>
      );
    }
    case "failure":
      return (
        <Frame context={context} title={screen.title}>
          <ErrorBlock error={screen.error} />
          <Box marginTop={1}>
            <KeyHints hints={[{ keys: "Enter", label: "back to the menu" }]} />
          </Box>
          <BackOnEscape onBack={() => home()} />
        </Frame>
      );
    case "history":
      return (
        <History
          context={context}
          loaded={loaded}
          error={historyError}
          onBack={() => home()}
          onOpen={(record) => {
            if (record.status !== "completed") {
              setHistoryError(
                `That scan is ${record.status}${record.error ? `: ${record.error}` : ""}. Only completed scans have findings to show.`,
              );
              return;
            }
            void readScanFindings(record.scanDir).then(
              (findings) => setScreen({ name: "historyDetail", record, findings }),
              (error: unknown) =>
                setHistoryError(
                  `Couldn't read the findings in ${record.scanDir}. ${describeError(error)}`,
                ),
            );
          }}
        />
      );
    case "historyDetail": {
      const { record, findings } = screen;
      return (
        <Frame context={context} title="Past scan">
          <FindingsView
            heading={
              <Text>
                <Text bold>{displayPath(record.repository, context.env)}</Text>
                <Faint>{`  ${describeTarget(record.target)} · ${record.mode} · ${formatAge(record.startedAt)} ago`}</Faint>
              </Text>
            }
            facts={[
              ["Report", record.reportPath ?? record.scanDir],
              ["Scan ID", record.scanId],
              [
                "Model",
                `${record.model} (${record.effort})${record.providers.length > 0 ? ` via ${record.providers.join(", ")}` : ""}`,
              ],
            ]}
            findings={findings}
            columns={columns - 2}
            rows={rows}
            onBack={() => {
              setHistoryError(undefined);
              setScreen({ name: "history" });
            }}
          />
        </Frame>
      );
    }
    case "providers":
      return (
        <Providers
          context={context}
          loaded={loaded}
          reload={reload}
          onAdd={() => setScreen({ name: "providerAdd" })}
          onBack={() => home()}
        />
      );
    case "providerAdd":
      return (
        <Frame context={context} title="Add a provider">
          <ProviderWizard
            env={context.env}
            config={loaded.config}
            keys={loaded.keys}
            first={false}
            signal={context.signal}
            save={(provider, apiKey) => saveProvider(context, provider, apiKey, false)}
            onDone={(result) => {
              void reload().then(() =>
                home(
                  `Added provider ${result.provider.name} at position ${result.position} of ${result.total}.`,
                ),
              );
            }}
            onCancel={() =>
              setScreen(
                (loaded.config.providers ?? []).length > 0
                  ? { name: "providers" }
                  : { name: "home" },
              )
            }
          />
        </Frame>
      );
    case "settings":
      return <Settings context={context} loaded={loaded} reload={reload} onBack={() => home()} />;
    case "doctor":
      return <Doctor context={context} onBack={() => home()} />;
  }
}

/** Open the interactive UI on the alternate screen and resolve when the person leaves it. */
const SHUTDOWN_LIMIT_MS = 15_000;

export async function runApp(context: AppContext): Promise<number> {
  let interrupted = false;
  const instance = render(
    <ColorProvider color={context.terminal.stdoutColor}>
      <App context={context} onInterrupt={() => (interrupted = true)} />
    </ColorProvider>,
    { exitOnCtrlC: false, patchConsole: false, alternateScreen: true },
  );
  await instance.waitUntilExit();
  // A scan that was still running is being stopped; give it a bounded time to shut down cleanly.
  if (pendingWork.size > 0) {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_LIMIT_MS);
    });
    await Promise.race([Promise.allSettled([...pendingWork]), limit]);
    clearTimeout(timer);
  }
  // Quit is a normal end; Ctrl+C and signals report how the session was ended.
  const signal = context.abortSignalName();
  if (signal !== undefined) return signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 130;
  return interrupted ? 130 : 0;
}
