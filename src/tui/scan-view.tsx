import { basename } from "node:path";

import { Box, Text } from "ink";
import { type ReactNode, useEffect, useState } from "react";

import { formatClock, formatTokensShort, formatUsd } from "../cli/format.js";
import type { UsageSummary } from "../gateway/usage.js";
import { describeTarget } from "../scan/history.js";
import type { ScanPlan } from "../scan/plan.js";
import type { ScanEvent, ScanPhase } from "../scan/runner.js";
import { Faint, Row, Spinner, Tint } from "./components.js";

const MAX_ACTIVITIES = 6;
const MAX_NOTICES = 3;

export interface ActivityLine {
  id: string;
  kind: string;
  status: "running" | "completed" | "failed";
  description: string;
  worker: number | undefined;
}

/** Everything the live view shows, derived only from scan events. */
export interface ScanViewState {
  stage: "preparing" | "starting" | "scanning" | "finishing";
  phase: ScanPhase | undefined;
  filesCompleted: number;
  filesTotal: number;
  reviewItems: { completed: number; total: number } | undefined;
  deep: { completed: number; active: number; maximum: number; consolidating: boolean } | undefined;
  scanId: string | undefined;
  provider: { name: string; model: string } | undefined;
  usage: UsageSummary | undefined;
  activities: ActivityLine[];
  notices: string[];
  reconnect: { attempt: number; maxAttempts: number } | undefined;
}

export function initialScanViewState(): ScanViewState {
  return {
    stage: "preparing",
    phase: undefined,
    filesCompleted: 0,
    filesTotal: 0,
    reviewItems: undefined,
    deep: undefined,
    scanId: undefined,
    provider: undefined,
    usage: undefined,
    activities: [],
    notices: [],
    reconnect: undefined,
  };
}

function pushNotice(notices: readonly string[], notice: string): string[] {
  return [...notices.filter((item) => item !== notice), notice].slice(-MAX_NOTICES);
}

/** Fold one scan event into the view state. Pure, so it is easy to test. */
export function reduceScanEvent(state: ScanViewState, event: ScanEvent): ScanViewState {
  switch (event.type) {
    case "stage":
      return { ...state, stage: event.stage };
    case "registered":
      return { ...state, scanId: event.scanId };
    case "progress":
      return {
        ...state,
        phase: event.phase,
        filesCompleted: event.filesCompleted,
        filesTotal: event.filesTotal,
        reviewItems: event.reviewItems,
      };
    case "deep_progress":
      return {
        ...state,
        deep: {
          completed: event.completed,
          active: event.active,
          maximum: event.maximum,
          consolidating: event.consolidating,
        },
      };
    case "activity": {
      const line: ActivityLine = {
        id: event.id,
        kind: event.kind,
        status: event.status,
        description: event.description,
        worker: event.worker,
      };
      const without = state.activities.filter((item) => item.id !== event.id);
      return {
        ...state,
        activities: [...without, line].slice(-MAX_ACTIVITIES),
        reconnect: undefined,
      };
    }
    case "usage":
      return { ...state, usage: event.usage, reconnect: undefined };
    case "provider":
      return { ...state, provider: { name: event.provider, model: event.model } };
    case "fallback":
      return {
        ...state,
        notices: pushNotice(
          state.notices,
          `${event.from} failed (${event.reason}). Falling back to ${event.to}.`,
        ),
      };
    case "provider_failure":
      return state;
    case "reconnect":
      return { ...state, reconnect: { attempt: event.attempt, maxAttempts: event.maxAttempts } };
    case "warning":
      return { ...state, notices: pushNotice(state.notices, event.message) };
    default:
      return state;
  }
}

const PHASE_LABELS: Record<ScanPhase, string> = {
  preflight: "Checking inputs",
  threat_model: "Building the threat model",
  discovery: "Reviewing files",
  attack_path: "Tracing attack paths",
  validation: "Validating findings",
  reporting: "Writing the report",
};

const PHASE_ORDER: readonly ScanPhase[] = ["threat_model", "discovery", "validation", "reporting"];

export function statusLine(state: ScanViewState): string {
  if (state.stage === "preparing") return "Preparing the scan";
  if (state.stage === "starting") return "Starting Codex Security";
  if (state.stage === "finishing") return "Saving the results";
  if (state.deep?.consolidating) return "Combining results";
  if (state.phase === undefined) return "Starting the scan";
  return PHASE_LABELS[state.phase];
}

function progressDetail(state: ScanViewState): string {
  if (state.stage !== "scanning") return "";
  if (state.deep) {
    return `${state.deep.completed} of up to ${state.deep.maximum} reviews done, ${state.deep.active} running`;
  }
  if (state.reviewItems && state.reviewItems.total > 0) {
    return `${state.reviewItems.completed}/${state.reviewItems.total} reviews`;
  }
  if (state.filesTotal > 0 && state.phase !== undefined && state.phase !== "threat_model") {
    return `${state.filesCompleted}/${state.filesTotal} files`;
  }
  return state.filesTotal > 0 ? `${state.filesTotal} files` : "";
}

const KIND_LABELS: Record<string, string> = {
  command: "run",
  tool: "tool",
  reasoning: "think",
  message: "note",
};

/** Ticks once a second so the elapsed clock moves even when no event arrives. */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, now - startedAt);
}

export interface ScanViewProps {
  plan: ScanPlan;
  state: ScanViewState;
  startedAt: number;
  /** Terminal width, to keep long lines on one row. */
  columns: number;
  footer?: ReactNode;
}

export function ScanView(props: ScanViewProps): ReactNode {
  const { plan, state } = props;
  const elapsed = useElapsed(props.startedAt);
  const detail = progressDetail(state);
  const provider = state.provider ?? { name: plan.chain[0]!.name, model: plan.chain[0]!.model };
  const fallbacks = plan.chain.length - 1;
  const usage = state.usage;
  const width = Math.max(40, Math.min(props.columns, 110));
  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Box flexShrink={1}>
          <Text bold wrap="truncate-end">
            Scanning {basename(plan.repository) || plan.repository}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text>{formatClock(elapsed)}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Spinner />
        <Text bold> {statusLine(state)}…</Text>
        {detail ? <Faint>{`  ${detail}`}</Faint> : null}
      </Box>
      <Box>
        <Text>{"  "}</Text>
        {PHASE_ORDER.map((phase, index) => {
          const current =
            state.phase === undefined
              ? -1
              : Math.max(
                  0,
                  PHASE_ORDER.indexOf(
                    state.phase === "attack_path"
                      ? "validation"
                      : state.phase === "preflight"
                        ? "threat_model"
                        : state.phase,
                  ),
                );
          const done = index < current;
          const active = index === current && state.stage === "scanning";
          return (
            <Text key={phase}>
              {index > 0 ? <Faint> › </Faint> : null}
              {done ? (
                <Tint tone="success">{PHASE_LABELS[phase]}</Tint>
              ) : active ? (
                <Text bold>{PHASE_LABELS[phase]}</Text>
              ) : (
                <Faint>{PHASE_LABELS[phase]}</Faint>
              )}
            </Text>
          );
        })}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Row label="Scope">{`${describeTarget(plan.target)} · ${plan.mode}`}</Row>
        <Row label="Provider">
          {`${provider.name} · ${provider.model} · effort ${plan.effort}`}
          {fallbacks > 0 ? `  (+${fallbacks} fallback${fallbacks === 1 ? "" : "s"})` : ""}
        </Row>
        <Row label="Tokens">
          {usage && usage.requests > 0
            ? `${formatTokensShort(usage.total.inputTokens)} in · ${formatTokensShort(usage.total.outputTokens)} out · ${usage.requests} request${usage.requests === 1 ? "" : "s"}${usage.costUsd !== null ? ` · ${formatUsd(usage.costUsd)}` : ""}`
            : "waiting for the first response"}
        </Row>
        {state.scanId ? <Row label="Scan ID">{state.scanId}</Row> : null}
      </Box>

      {state.activities.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Faint>Recent activity</Faint>
          {state.activities.map((activity) => (
            <Text key={activity.id} wrap="truncate-end">
              {activity.status === "running" ? (
                <Tint tone="accent">{"  › "}</Tint>
              ) : activity.status === "failed" ? (
                <Tint tone="danger">{"  ✗ "}</Tint>
              ) : (
                <Faint>{"  · "}</Faint>
              )}
              <Faint>{(KIND_LABELS[activity.kind] ?? activity.kind).padEnd(6)}</Faint>
              {activity.worker === undefined ? "" : `[${activity.worker}] `}
              {activity.description}
            </Text>
          ))}
        </Box>
      ) : null}

      {state.reconnect ? (
        <Box marginTop={1}>
          <Tint tone="warning">! </Tint>
          <Text>
            Retrying automatically… {state.reconnect.attempt}/{state.reconnect.maxAttempts}
          </Text>
        </Box>
      ) : null}
      {state.notices.length > 0 ? (
        <Box flexDirection="column" marginTop={state.reconnect ? 0 : 1}>
          {state.notices.map((notice) => (
            <Text key={notice} wrap="truncate-end">
              <Tint tone="warning">! </Tint>
              {notice}
            </Text>
          ))}
        </Box>
      ) : null}
      {props.footer ? <Box marginTop={1}>{props.footer}</Box> : null}
    </Box>
  );
}
