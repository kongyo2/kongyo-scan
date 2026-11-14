import { cleanup, render } from "ink-testing-library";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../src/config/schema.js";
import { resolveScanPlan } from "../../src/scan/plan.js";
import type { ScanEvent } from "../../src/scan/runner.js";
import { ColorProvider, KeyHints, SelectList, TextField } from "../../src/tui/components.js";
import {
  initialScanViewState,
  reduceScanEvent,
  ScanView,
  type ScanViewState,
  statusLine,
} from "../../src/tui/scan-view.js";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ENTER = "\r";
const ESCAPE = "\u001b";

afterEach(() => {
  cleanup();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

function fold(
  events: readonly ScanEvent[],
  state: ScanViewState = initialScanViewState(),
): ScanViewState {
  return events.reduce(reduceScanEvent, state);
}

function usage(inputTokens: number, outputTokens: number, requests: number) {
  const total = {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    estimated: false,
  };
  return { providers: [], total, requests, costUsd: null };
}

describe("scan view state", () => {
  it("follows a scan from preparation to the report", () => {
    let state = initialScanViewState();
    expect(statusLine(state)).toBe("Preparing the scan");
    state = fold([{ type: "stage", stage: "starting" }], state);
    expect(statusLine(state)).toBe("Starting Codex Security");
    state = fold(
      [
        { type: "stage", stage: "scanning" },
        { type: "registered", scanId: "scan-1", scanDir: "/state/scan-1" },
      ],
      state,
    );
    expect(statusLine(state)).toBe("Starting the scan");
    expect(state.scanId).toBe("scan-1");
    state = fold(
      [
        {
          type: "progress",
          phase: "discovery",
          filesCompleted: 2,
          filesTotal: 5,
          reviewItems: undefined,
        },
      ],
      state,
    );
    expect(statusLine(state)).toBe("Reviewing files");
    expect(state).toMatchObject({ filesCompleted: 2, filesTotal: 5 });
    state = fold(
      [
        {
          type: "progress",
          phase: "reporting",
          filesCompleted: 5,
          filesTotal: 5,
          reviewItems: undefined,
        },
        { type: "stage", stage: "finishing" },
      ],
      state,
    );
    expect(statusLine(state)).toBe("Saving the results");
  });

  it("keeps the newest activity lines and updates one in place", () => {
    const events: ScanEvent[] = Array.from({ length: 8 }, (_, index) => ({
      type: "activity",
      id: `a${index}`,
      kind: "command",
      status: "running",
      description: `step ${index}`,
      worker: undefined,
    }));
    let state = fold(events);
    expect(state.activities.map((activity) => activity.id)).toEqual([
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
      "a7",
    ]);
    state = fold(
      [
        {
          type: "activity",
          id: "a5",
          kind: "command",
          status: "completed",
          description: "step 5",
          worker: 2,
        },
      ],
      state,
    );
    expect(state.activities.map((activity) => activity.id)).toEqual([
      "a2",
      "a3",
      "a4",
      "a6",
      "a7",
      "a5",
    ]);
    expect(state.activities.at(-1)).toMatchObject({ status: "completed", worker: 2 });
  });

  it("shows fallbacks and warnings once and clears a retry notice on progress", () => {
    let state = fold([
      { type: "fallback", from: "one", to: "two", reason: "rate limited" },
      { type: "fallback", from: "one", to: "two", reason: "rate limited" },
      { type: "warning", message: "first" },
      { type: "warning", message: "second" },
      { type: "warning", message: "third" },
      { type: "reconnect", attempt: 2, maxAttempts: 5, reason: undefined },
    ]);
    expect(state.notices).toEqual(["first", "second", "third"]);
    expect(state.reconnect).toEqual({ attempt: 2, maxAttempts: 5 });
    state = fold([{ type: "usage", usage: usage(10, 5, 1) }], state);
    expect(state.reconnect).toBeUndefined();
    state = fold([{ type: "provider", provider: "two", model: "model-b" }], state);
    expect(state.provider).toEqual({ name: "two", model: "model-b" });
    state = fold(
      [
        { type: "deep_progress", completed: 1, active: 2, maximum: 8, consolidating: true },
        { type: "stage", stage: "scanning" },
      ],
      state,
    );
    expect(statusLine(state)).toBe("Combining results");
  });
});

describe("scan view", () => {
  const config: Config = {
    providers: [
      { name: "main", base_url: "https://one.example/v1", model: "model-a", api_key: "k" },
      { name: "backup", base_url: "https://two.example/v1", model: "model-b", api_key: "k" },
    ],
    reasoning_effort: "max",
  };
  const plan = resolveScanPlan({ cli: { paths: ["src"] }, config, cwd: "/work/my-repo", env: {} });

  it("renders the scope, the provider chain, and live progress without color", () => {
    const state = fold([
      { type: "stage", stage: "scanning" },
      { type: "registered", scanId: "scan-1", scanDir: "/state/scan-1" },
      {
        type: "progress",
        phase: "discovery",
        filesCompleted: 1,
        filesTotal: 4,
        reviewItems: undefined,
      },
      { type: "usage", usage: usage(120_000, 3400, 7) },
      {
        type: "activity",
        id: "c1",
        kind: "command",
        status: "running",
        description: "rg -n exec src",
        worker: undefined,
      },
      { type: "fallback", from: "main", to: "backup", reason: "HTTP 503" },
      { type: "provider", provider: "backup", model: "model-b" },
    ]);
    const { lastFrame } = render(
      <ColorProvider color={false}>
        <ScanView plan={plan} state={state} startedAt={Date.now() - 65_000} columns={90} />
      </ColorProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Scanning my-repo");
    expect(frame).toMatch(/1:0\d/u);
    expect(frame).toContain("Reviewing files…  1/4 files");
    expect(frame).toContain("src · standard");
    expect(frame).toContain("backup · model-b · effort max  (+1 fallback)");
    expect(frame).toContain("120K in · 3,400 out · 7 requests");
    expect(frame).toContain("scan-1");
    expect(frame).toContain("run   rg -n exec src");
    expect(frame).toContain("! main failed (HTTP 503). Falling back to backup.");
    expect(frame).not.toContain("\u001b[");
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(90);
  });

  it("waits visibly before the first response", () => {
    const { lastFrame } = render(
      <ScanView plan={plan} state={initialScanViewState()} startedAt={Date.now()} columns={80} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Preparing the scan…");
    expect(frame).toContain("main · model-a · effort max  (+1 fallback)");
    expect(frame).toContain("waiting for the first response");
  });
});

describe("select list", () => {
  const choices = [
    { value: "a", label: "Alpha", hint: "first" },
    { value: "b", label: "Beta", disabled: true },
    { value: "c", label: "Gamma", hint: "third" },
  ];

  it("moves past disabled choices, wraps, and selects with Enter", async () => {
    const selected: string[] = [];
    let canceled = 0;
    const { lastFrame, stdin } = render(
      <SelectList
        choices={choices}
        onSelect={(value) => selected.push(value)}
        onCancel={() => (canceled += 1)}
      />,
    );
    expect(lastFrame()).toContain("› Alpha  first");
    stdin.write(DOWN);
    await settle();
    expect(lastFrame()).toContain("› Gamma  third");
    stdin.write(DOWN);
    await settle();
    expect(lastFrame()).toContain("› Alpha");
    stdin.write(UP);
    await settle();
    stdin.write(ENTER);
    await settle();
    expect(selected).toEqual(["c"]);
    stdin.write(ESCAPE);
    await settle();
    expect(canceled).toBe(1);
  });

  it("filters as you type and scrolls long lists", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      value: index,
      label: `model-${String(index).padStart(2, "0")}`,
    }));
    const selected: number[] = [];
    const { lastFrame, stdin } = render(
      <SelectList choices={many} searchable limit={5} onSelect={(value) => selected.push(value)} />,
    );
    expect(lastFrame()).toContain("↓ 25 more");
    stdin.write("2");
    await settle();
    stdin.write("7");
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Filter: 27");
    expect(frame).toContain("› model-27");
    expect(frame).not.toContain("model-26");
    stdin.write(ENTER);
    await settle();
    expect(selected).toEqual([27]);
    stdin.write("x");
    await settle();
    expect(lastFrame()).toContain("No choices match this filter.");
  });
});

describe("text field", () => {
  function Field(props: { mask?: boolean; onSubmit: (value: string) => void }) {
    const [value, setValue] = useState("");
    return (
      <TextField
        value={value}
        onChange={setValue}
        onSubmit={props.onSubmit}
        placeholder="type here"
        mask={props.mask === true}
      />
    );
  }

  it("edits, clears, and submits", async () => {
    const submitted: string[] = [];
    const { lastFrame, stdin } = render(<Field onSubmit={(value) => submitted.push(value)} />);
    expect(lastFrame()).toContain("type here");
    stdin.write("abc");
    await settle();
    stdin.write("\u007f");
    await settle();
    expect(lastFrame()).toContain("ab");
    expect(lastFrame()).not.toContain("abc");
    stdin.write(ENTER);
    await settle();
    expect(submitted).toEqual(["ab"]);
    stdin.write("\u0015");
    await settle();
    expect(lastFrame()).toContain("type here");
  });

  it("never shows a masked value", async () => {
    const submitted: string[] = [];
    const { lastFrame, stdin, frames } = render(
      <Field mask onSubmit={(value) => submitted.push(value)} />,
    );
    stdin.write("sk-secret-value");
    await settle();
    expect(lastFrame()).toContain("•".repeat(15));
    stdin.write(ENTER);
    await settle();
    expect(submitted).toEqual(["sk-secret-value"]);
    expect(frames.join("\n")).not.toContain("sk-secret-value");
  });
});

describe("key hints", () => {
  it("lists the keys that work", () => {
    const { lastFrame } = render(
      <ColorProvider color={false}>
        <KeyHints
          hints={[
            { keys: "↑↓", label: "move" },
            { keys: "enter", label: "select" },
          ]}
        />
      </ColorProvider>,
    );
    expect(lastFrame()).toBe("↑↓ move  enter select");
  });
});
