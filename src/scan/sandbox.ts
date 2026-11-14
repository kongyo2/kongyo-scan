import { execFile } from "node:child_process";
import { access, constants, mkdir, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type { CodexCommand } from "@openai/codex-security";

import { CliError, type NextStep, sanitizeLine } from "../core/errors.js";
import type { AppPaths } from "../core/paths.js";
import { BIN } from "../version.js";

type Env = Readonly<Record<string, string | undefined>>;

const run = promisify(execFile);

export const SANDBOX_HELP_URL = "https://github.com/kongyo2/kongyo-scan#linux-sandbox";

/** How long Codex Security waits for the same check. */
const SANDBOX_PROBE_TIMEOUT_MS = 10_000;

/** What Codex Security reports when its own sandbox check fails, around the native output. */
const PROBE_PREFIX = "Codex could not run a command in its sandbox: ";
const PROBE_SUFFIX = "\nTo reproduce, run '";

/** Codex prints this from inside a working sandbox; it says nothing about a failure. */
const NOISE = /^WARNING: proceeding, even though we could not create PATH aliases/u;

/** How Bubblewrap fails when it is not allowed to set up a user namespace. */
const USER_NAMESPACE_FAILURES = [
  /loopback: Failed RTM_NEW(?:ADDR|LINK)/u,
  /setting up uid map: Permission denied/u,
  /No permissions to creat(?:e a|ing) new namespace/u,
  /Creating new namespace failed/u,
];

const APPARMOR_RESTRICTION = "proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const APPARMOR_PROFILES = ["etc/apparmor.d/bwrap", "etc/apparmor.d/bwrap-userns-restrict"];
const CONTAINER_MARKERS = [".dockerenv", "run/.containerenv"];
const DEFAULT_BUBBLEWRAP = "/usr/bin/bwrap";

export interface SandboxFacts {
  /** The first bwrap on PATH. Codex uses it, and falls back to its bundled copy without one. */
  bubblewrap: string | undefined;
  /** AppArmor keeps user namespaces to programs whose profile allows them (Ubuntu 24.04 and later). */
  apparmorRestricted: boolean;
  /** A profile for Bubblewrap that is installed, whether or not it is loaded. */
  apparmorProfile: string | undefined;
  container: boolean;
}

export interface SandboxDiagnosis {
  cause: "user_namespaces" | "unknown";
  /** What the sandbox fails to do, to follow "The command sandbox". */
  problem: string;
  /** The line the sandbox itself printed. */
  diagnostic: string;
  /** Why, on this machine, when that is known. */
  reason: string | undefined;
  /** What to do about it. */
  fix: string | undefined;
  next: NextStep[];
}

/** The home Codex Security gives Codex during a scan, where it writes the scan's permissions. */
export function sandboxCodexHome(paths: AppPaths): string {
  return join(paths.stateDir, "codex-home");
}

/** Picks the line that explains a sandbox failure out of the SDK's message or the raw output. */
export function sandboxDiagnostic(message: string): string {
  const start = message.indexOf(PROBE_PREFIX);
  let text = start < 0 ? message : message.slice(start + PROBE_PREFIX.length);
  const end = text.indexOf(PROBE_SUFFIX);
  if (end >= 0) text = text.slice(0, end);
  const lines = text
    .split(/\r?\n/u)
    .map(sanitizeLine)
    .filter((line) => line !== "" && !NOISE.test(line));
  const line = lines.find((candidate) => candidate.startsWith("bwrap: ")) ?? lines.join(" ");
  return (line || sanitizeLine(message)).slice(0, 300);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  const found = await Promise.all(paths.map(exists));
  return paths.find((_, index) => found[index]);
}

async function findOnPath(program: string, env: Env): Promise<string | undefined> {
  // A relative entry would resolve inside the repository; Codex skips those as well.
  const directories = (env["PATH"] ?? "").split(delimiter).filter(isAbsolute);
  for (const directory of directories) {
    const candidate = join(directory, program);
    try {
      // oxlint-disable-next-line no-await-in-loop -- PATH is searched in order; the first match decides.
      if (!(await stat(candidate)).isFile()) continue;
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function readSandboxFacts(env: Env = process.env, root = "/"): Promise<SandboxFacts> {
  const [bubblewrap, restriction, apparmorProfile, marker] = await Promise.all([
    findOnPath("bwrap", env),
    readFile(join(root, APPARMOR_RESTRICTION), "utf8").catch(() => ""),
    firstExisting(APPARMOR_PROFILES.map((path) => join(root, path))),
    firstExisting(CONTAINER_MARKERS.map((path) => join(root, path))),
  ]);
  return {
    bubblewrap,
    apparmorRestricted: restriction.trim() === "1",
    apparmorProfile,
    container: marker !== undefined,
  };
}

export function diagnoseSandbox(
  diagnostic: string,
  facts: SandboxFacts,
  platform: NodeJS.Platform = process.platform,
): SandboxDiagnosis {
  const next: NextStep[] = [{ label: "Check the sandbox again", argv: [BIN, "doctor"] }];
  if (
    platform !== "linux" ||
    !USER_NAMESPACE_FAILURES.some((pattern) => pattern.test(diagnostic))
  ) {
    return {
      cause: "unknown",
      problem: "isn't available",
      diagnostic,
      reason: undefined,
      fix: platform === "linux" ? `See what the sandbox needs: ${SANDBOX_HELP_URL}` : undefined,
      next,
    };
  }

  const diagnosis = (reason: string | undefined, fix: string): SandboxDiagnosis => ({
    cause: "user_namespaces",
    problem: "can't create user namespaces",
    diagnostic,
    reason,
    fix: `${fix} Steps: ${SANDBOX_HELP_URL}`,
    next,
  });
  const bubblewrap = facts.bubblewrap ?? DEFAULT_BUBBLEWRAP;

  if (facts.container) {
    return diagnosis(
      "This is a container, and its runtime doesn't let Bubblewrap create user namespaces.",
      "Scan on the host, or let the container create user namespaces.",
    );
  }
  if (!facts.apparmorRestricted) {
    return diagnosis(undefined, "Allow unprivileged user namespaces for Bubblewrap.");
  }
  if (facts.bubblewrap === undefined) {
    return facts.apparmorProfile === undefined
      ? diagnosis(
          "AppArmor restricts unprivileged user namespaces here, and Bubblewrap isn't installed.",
          `Install the bubblewrap package, then add an AppArmor profile for ${bubblewrap}.`,
        )
      : diagnosis(
          `AppArmor allows user namespaces only for ${bubblewrap} here, and Bubblewrap isn't installed.`,
          "Install the bubblewrap package.",
        );
  }
  return facts.apparmorProfile === undefined
    ? diagnosis(
        `AppArmor restricts unprivileged user namespaces here, and ${bubblewrap} has no profile that allows them.`,
        `Add an AppArmor profile for ${bubblewrap}, then reload AppArmor.`,
      )
    : diagnosis(
        `AppArmor restricts unprivileged user namespaces here, and the profile in ${facts.apparmorProfile} isn't in effect for ${bubblewrap}.`,
        "Reload AppArmor with sudo systemctl reload apparmor, and check that the profile names that path.",
      );
}

/**
 * Runs one command in the Codex sandbox, as Codex Security does before a scan. Resolves with
 * the reason when the sandbox doesn't work, and with nothing when it does.
 */
export async function probeSandbox(
  command: CodexCommand,
  env: Env,
  codexHome: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_PROBE_TIMEOUT_MS;
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  try {
    await run(
      command.command,
      [...(command.args ?? []), "sandbox", "--", command.command, "--version"],
      {
        env: { ...env, CODEX_HOME: codexHome },
        timeout: timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    return undefined;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; killed?: boolean; code?: unknown };
    if (options.signal?.aborted) return "The sandbox check was stopped.";
    if (failure.killed === true) {
      return `The sandbox didn't answer within ${timeoutMs / 1000} seconds.`;
    }
    const output = failure.stderr?.trim() || failure.stdout?.trim();
    if (output) return sandboxDiagnostic(output);
    return typeof failure.code === "number"
      ? `Codex exited with status ${failure.code}.`
      : sanitizeLine(error instanceof Error ? error.message : String(error));
  }
}

/** The error for a scan that Codex Security refused to start without a working sandbox. */
export function sandboxUnavailableError(
  error: Error,
  facts: SandboxFacts,
  platform: NodeJS.Platform = process.platform,
): CliError {
  const diagnosis = diagnoseSandbox(sandboxDiagnostic(error.message), facts, platform);
  const summary = `The command sandbox ${diagnosis.problem} on this machine.`;
  return new CliError("platform", `Can't start the scan. ${summary}`, {
    reason: "unsupported_runtime",
    details: [diagnosis.diagnostic, ...(diagnosis.reason === undefined ? [] : [diagnosis.reason])],
    ...(diagnosis.fix === undefined ? {} : { hint: diagnosis.fix }),
    next: diagnosis.next,
    data: {
      sandbox: {
        cause: diagnosis.cause,
        diagnostic: diagnosis.diagnostic,
        reason: diagnosis.reason ?? null,
        fix: diagnosis.fix ?? null,
      },
    },
    cause: error,
  });
}
