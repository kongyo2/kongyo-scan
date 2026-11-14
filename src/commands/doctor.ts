import { execFile } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { promisify } from "node:util";

import type { AppContext } from "../app/context.js";
import { loadKeys } from "../app/context.js";
import type { CommandSpec } from "../cli/args.js";
import { loadConfigFile } from "../config/store.js";
import { CliError, describeError } from "../core/errors.js";
import { displayPath } from "../core/paths.js";
import { availableProviders } from "../providers/resolve.js";
import { BIN, bundledCodexSecurityVersion, VERSION } from "../version.js";

const run = promisify(execFile);

export type CheckStatus = "ok" | "warning" | "failed";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 22 && minor >= 13) || major === 24 || major === 26;
}

async function commandVersion(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await run(command, args, { timeout: 15_000, signal });
    return (stdout || stderr).trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

async function pythonCheck(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<DoctorCheck> {
  const candidates = [configured, env["PYTHON"], "python3", "python"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- candidates are tried in order; the first interpreter found decides.
    const version = await commandVersion(candidate, ["--version"], signal);
    const match = version ? /Python (\d+)\.(\d+)/u.exec(version) : null;
    if (!match) continue;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    if (major > 3 || (major === 3 && minor >= 10))
      return { name: "Python", status: "ok", detail: `${version} (${candidate})` };
    return {
      name: "Python",
      status: "failed",
      detail: `${version} (${candidate}) is older than 3.10`,
      fix: "Install Python 3.10 or newer, or set the python setting to a newer interpreter.",
    };
  }
  return {
    name: "Python",
    status: "failed",
    detail: "not found",
    fix: "Install Python 3.10 or newer. Codex Security needs it for scans and scan history.",
  };
}

async function writable(directory: string): Promise<boolean> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctorChecks(context: AppContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const node = process.versions.node;
  checks.push(
    nodeSupported(node)
      ? { name: "Node.js", status: "ok", detail: node }
      : {
          name: "Node.js",
          status: "failed",
          detail: `${node} is not supported`,
          fix: "Use Node.js 22.13 or newer within 22.x, or Node.js 24.x or 26.x.",
        },
  );

  const engine = bundledCodexSecurityVersion();
  checks.push(
    engine
      ? { name: "Codex Security", status: "ok", detail: `@openai/codex-security ${engine}` }
      : {
          name: "Codex Security",
          status: "failed",
          detail: "@openai/codex-security could not be loaded",
          fix: `Reinstall ${BIN}: npm install --global @kongyo2/kongyo-scan`,
        },
  );

  let configuredPython: string | undefined;
  try {
    const { config, exists } = await loadConfigFile(context.paths.configFile);
    configuredPython = config.python;
    const providers = availableProviders(config, context.env).filter(
      (provider) => provider.disabled !== true,
    );
    checks.push({
      name: "Settings",
      status: "ok",
      detail: exists
        ? displayPath(context.paths.configFile, context.env)
        : `${displayPath(context.paths.configFile, context.env)} (not created yet)`,
    });
    if (providers.length === 0) {
      checks.push({
        name: "Providers",
        status: "failed",
        detail: "none configured",
        fix: `Add one: ${BIN} providers add`,
      });
    } else {
      const keys = await loadKeys(context);
      const missingKeys = providers.filter(
        (provider) =>
          provider.api_key === undefined &&
          keys[provider.name.toLowerCase()] === undefined &&
          provider.api_key_env !== undefined &&
          !(context.env[provider.api_key_env] ?? "").trim(),
      );
      const inlineKeys = providers.filter((provider) => provider.api_key !== undefined);
      if (missingKeys.length > 0) {
        checks.push({
          name: "Providers",
          status: "warning",
          detail: `${providers.length} configured; ${missingKeys.map((provider) => `$${provider.api_key_env}`).join(", ")} is not set`,
          fix: "Export the variable, or store the key with providers update --api-key-stdin.",
        });
      } else if (inlineKeys.length > 0) {
        checks.push({
          name: "Providers",
          status: "warning",
          detail: `${inlineKeys.map((provider) => provider.name).join(", ")} keeps its API key in the settings file, which scans can read`,
          fix: `Move it to protected storage: ${BIN} providers update ${inlineKeys[0]!.name} --api-key-stdin`,
        });
      } else {
        checks.push({
          name: "Providers",
          status: "ok",
          detail: `${providers.map((provider) => provider.name).join(" -> ")}`,
        });
      }
    }
  } catch (error) {
    checks.push({
      name: "Settings",
      status: "failed",
      detail: error instanceof CliError ? error.message : describeError(error),
      fix: `Fix or remove ${context.paths.configFile}.`,
    });
  }

  checks.push(await pythonCheck(configuredPython, context.env, context.signal));

  try {
    const sdk = await import("@openai/codex-security");
    const command = sdk.resolveCodexCommand(context.env);
    const version = await commandVersion(
      command.command,
      [...(command.args ?? []), "--version"],
      context.signal,
    );
    checks.push(
      version
        ? { name: "Codex runtime", status: "ok", detail: version }
        : {
            name: "Codex runtime",
            status: "failed",
            detail: "the bundled Codex executable did not start",
            fix: `Reinstall ${BIN} so the executable for ${process.platform}-${process.arch} is downloaded.`,
          },
    );
  } catch (error) {
    checks.push({
      name: "Codex runtime",
      status: "failed",
      detail: describeError(error),
      fix: `Reinstall ${BIN}.`,
    });
  }

  const git = await commandVersion("git", ["--version"], context.signal);
  checks.push(
    git
      ? { name: "Git", status: "ok", detail: git }
      : {
          name: "Git",
          status: "warning",
          detail: "not found",
          fix: "Install Git to scan diffs and working-tree changes.",
        },
  );

  checks.push(
    (await writable(context.paths.home))
      ? { name: "State", status: "ok", detail: displayPath(context.paths.home, context.env) }
      : {
          name: "State",
          status: "failed",
          detail: `${context.paths.home} is not writable`,
          fix: "Set KONGYO_SCAN_HOME to a private, writable directory outside the repositories you scan.",
        },
  );

  return checks;
}

async function doctor(context: AppContext): Promise<number> {
  const { output, terminal } = context;
  const checks = await runDoctorChecks(context);
  const failed = checks.filter((check) => check.status === "failed").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  if (terminal.json) {
    output.json({
      checks,
      summary: { ok: checks.length - failed - warnings, warnings, failed },
      version: VERSION,
    });
    return failed > 0 ? 1 : 0;
  }
  const theme = output.out;
  for (const check of checks) {
    const mark =
      check.status === "ok"
        ? theme.rich
          ? theme.success("✓")
          : "ok"
        : check.status === "warning"
          ? theme.rich
            ? theme.warning("!")
            : "warning"
          : theme.rich
            ? theme.danger("✗")
            : "failed";
    output.line(
      theme.rich
        ? `${mark} ${check.name.padEnd(16)}${check.detail}`
        : `${check.name}\t${mark}\t${check.detail}`,
    );
    if (check.fix && theme.rich) output.line(`  ${" ".repeat(16)}${check.fix}`);
  }
  if (failed === 0) {
    output.next([
      {
        label: "Test the configured providers with a real request",
        argv: [BIN, "providers", "check"],
      },
    ]);
    return 0;
  }
  throw new CliError("platform", `${failed} of ${checks.length} checks failed.`, {
    reason: "unsupported_runtime",
    rows: checks
      .filter((check) => check.status === "failed")
      .map((check) => [check.name, check.fix ?? check.detail]),
    data: { checks },
  });
}

export const doctorCommand: CommandSpec<AppContext> = {
  name: "doctor",
  group: "Configure",
  summary: "Check that this machine can run scans",
  options: [{ name: "json", type: "boolean", description: "Output the result as JSON" }],
  notes: ["Runs local checks only. Use providers check to test endpoints with a real request."],
  run: doctor,
};
