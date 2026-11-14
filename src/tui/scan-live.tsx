import { render } from "ink";
import { type ReactNode, useEffect, useState } from "react";

import type { AppContext } from "../app/context.js";
import type { ScanPlan } from "../scan/plan.js";
import { runScan, type ScanEvent, type ScanOutcome } from "../scan/runner.js";
import { ColorProvider, Faint } from "./components.js";
import {
  initialScanViewState,
  reduceScanEvent,
  ScanView,
  type ScanViewState,
} from "./scan-view.js";

type Listener = (event: ScanEvent) => void;

function LiveScan(props: {
  plan: ScanPlan;
  subscribe: (listener: Listener) => () => void;
  startedAt: number;
  columns: number;
}): ReactNode {
  const [state, setState] = useState<ScanViewState>(initialScanViewState);
  useEffect(
    () => props.subscribe((event) => setState((current) => reduceScanEvent(current, event))),
    [props.subscribe],
  );
  return (
    <ScanView
      plan={props.plan}
      state={state}
      startedAt={props.startedAt}
      columns={props.columns}
      footer={<Faint>Ctrl+C stops the scan</Faint>}
    />
  );
}

export async function runScanWithLiveView(
  plan: ScanPlan,
  context: AppContext,
): Promise<ScanOutcome> {
  const listeners = new Set<Listener>();
  const backlog: ScanEvent[] = [];
  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    for (const event of backlog.splice(0)) listener(event);
    return () => listeners.delete(listener);
  };
  const startedAt = Date.now();
  context.output.info();
  const instance = render(
    <ColorProvider color={context.terminal.stderrColor}>
      <LiveScan
        plan={plan}
        subscribe={subscribe}
        startedAt={startedAt}
        columns={context.terminal.stderrColumns}
      />
    </ColorProvider>,
    { stdout: process.stderr, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    return await runScan(plan, context.paths, {
      signal: context.signal,
      onEvent: (event) => {
        if (listeners.size === 0) backlog.push(event);
        for (const listener of listeners) listener(event);
      },
    });
  } finally {
    instance.clear();
    instance.unmount();
    await instance.waitUntilExit().catch(() => undefined);
  }
}
