import { describe, expect, it } from "vitest";

import { Output } from "../../src/cli/output.js";
import { resolveTerminal } from "../../src/cli/terminal.js";
import { plainReporter } from "../../src/commands/scan.js";
import type { ScanEvent } from "../../src/scan/runner.js";

function report(events: readonly ScanEvent[]): string[] {
  const lines: string[] = [];
  const stream = { write: (chunk: string) => lines.push(chunk.trim()) > 0 };
  const output = new Output(
    resolveTerminal({}, {}, { stdin: {}, stdout: { write: () => true }, stderr: stream }),
  );
  const reporter = plainReporter(output, false);
  for (const event of events) reporter(event);
  return lines;
}

const reviews = (completed: number, active: number, consolidating = false): ScanEvent => ({
  type: "deep_progress",
  completed,
  active,
  maximum: 40,
  consolidating,
});

describe("plain scan progress", () => {
  it("names each phase of a standard scan once", () => {
    const phase = (name: "threat_model" | "discovery", filesCompleted: number): ScanEvent => ({
      type: "progress",
      phase: name,
      filesCompleted,
      filesTotal: 6,
      reviewItems: undefined,
    });
    expect(
      report([phase("threat_model", 0), phase("discovery", 0), phase("discovery", 3)]),
    ).toEqual(["Building the threat model...", "Reviewing files... 6 files"]);
  });

  it("follows a deep scan through its reviews and each time it combines results", () => {
    expect(
      report([
        reviews(0, 4),
        reviews(0, 4),
        reviews(3, 1),
        reviews(4, 0, true),
        reviews(4, 0, true),
        reviews(4, 4),
        reviews(8, 0, true),
      ]),
    ).toEqual([
      "Reviewing the code... up to 40 reviews",
      "3 of up to 40 reviews done",
      "4 of up to 40 reviews done",
      "Combining results...",
      "8 of up to 40 reviews done",
      "Combining results...",
    ]);
  });
});
