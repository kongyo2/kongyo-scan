import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gatewayArguments, runChild } from "../../src/commands/passthrough.js";
import { CliError } from "../../src/core/errors.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kscan-child-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function context(signalName?: NodeJS.Signals): {
  controller: AbortController;
  context: { signal: AbortSignal; abortSignalName(): NodeJS.Signals | undefined };
} {
  const controller = new AbortController();
  return {
    controller,
    context: { signal: controller.signal, abortSignalName: () => signalName },
  };
}

/** A child that records its PID, then waits; `onSignal` is the body of its signal handlers. */
function waitingChild(marker: string, onSignal: string): string[] {
  const script = `
    const fs = require("node:fs");
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => { fs.appendFileSync(${JSON.stringify(marker)} + ".signals", signal + "\\n"); ${onSignal} });
    }
    fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  return ["-e", script];
}

async function childPid(marker: string, attempts = 200): Promise<number> {
  const pid = Number(await readFile(marker, "utf8").catch(() => ""));
  if (pid > 0) return pid;
  if (attempts === 0) throw new Error("the child never started");
  await new Promise((resolve) => setTimeout(resolve, 25));
  return await childPid(marker, attempts - 1);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runChild", () => {
  it("reports the child's own exit code", async () => {
    expect(
      await runChild(process.execPath, ["-e", "process.exit(42)"], process.env, context().context),
    ).toBe(42);
  });

  it("fails as a spawn error when the child can't start", async () => {
    const error = await runChild(
      join(directory, "no-such-binary"),
      [],
      process.env,
      context().context,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).reason).toBe("spawn_failed");
  });
});

describe.skipIf(process.platform === "win32")("runChild signals", () => {
  it.each([
    ["SIGTERM", "SIGTERM", 143],
    ["SIGINT", "SIGINT", 130],
    ["SIGHUP", "SIGTERM", 129],
  ] as const)(
    "passes %s on to the child as %s and exits with %i",
    async (received, forwarded, code) => {
      const marker = join(directory, "pid");
      const { controller, context: stoppable } = context(received);
      const exit = runChild(
        process.execPath,
        waitingChild(marker, "process.exit(0);"),
        process.env,
        stoppable,
      );
      const pid = await childPid(marker);
      controller.abort();
      expect(await exit).toBe(code);
      expect(alive(pid)).toBe(false);
      expect((await readFile(`${marker}.signals`, "utf8")).trim()).toBe(forwarded);
    },
  );

  it("ends a child that ignores the stop request", async () => {
    const marker = join(directory, "pid");
    const { controller, context: stoppable } = context("SIGTERM");
    const exit = runChild(process.execPath, waitingChild(marker, ""), process.env, stoppable, 200);
    const pid = await childPid(marker);
    controller.abort();
    expect(await exit).toBe(143);
    expect(alive(pid)).toBe(false);
  });

  it("reports a signal that ended the child on its own", async () => {
    expect(
      await runChild(
        process.execPath,
        ["-e", 'process.kill(process.pid, "SIGKILL")'],
        process.env,
        context().context,
      ),
    ).toBe(137);
  });
});

describe("gatewayArguments", () => {
  const settings = { model: "model-a", effort: "max", baseUrl: "http://127.0.0.1:1234/v1" };

  it("routes a model command through the gateway unless the caller chose a provider", () => {
    const added = gatewayArguments(["scan", "."], settings);
    expect(added.slice(0, 4)).toEqual(["--model", "model-a", "--effort", "max"]);
    expect(added).toContain('model_provider="kongyo-scan"');
    expect(added).toContain('model_providers.kongyo-scan.base_url="http://127.0.0.1:1234/v1"');
    expect(gatewayArguments(["scan", ".", "--model", "other"], settings)).not.toContain("--model");
    expect(gatewayArguments(["scan", ".", "--effort=low"], settings)).not.toContain("--effort");
    expect(gatewayArguments(["scan", ".", "--provider", "openrouter"], settings)).toEqual([]);
  });
});
