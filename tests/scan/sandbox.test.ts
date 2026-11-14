import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../../src/core/errors.js";
import {
  diagnoseSandbox,
  probeSandbox,
  readSandboxFacts,
  SANDBOX_HELP_URL,
  sandboxCodexHome,
  sandboxDiagnostic,
  type SandboxFacts,
  sandboxUnavailableError,
} from "../../src/scan/sandbox.js";

const USERNS_DENIED = "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
const CODEX =
  "/usr/lib/node_modules/@kongyo2/kongyo-scan/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";

/** What Codex Security 0.10.0 throws on Ubuntu 24.04 when AppArmor has no profile for bwrap. */
const REPORTED = [
  `Codex could not run a command in its sandbox: ${USERNS_DENIED}`,
  `To reproduce, run '${CODEX} sandbox -- ${CODEX} --version'.`,
  "On Linux this usually means unprivileged user namespaces are restricted (kernel.apparmor_restrict_unprivileged_userns=1 on Ubuntu 24.04 and later), which Bubblewrap needs; inside the container image, use the AppArmor profile and Compose override from the SDK README.",
].join("\n");

const UBUNTU: SandboxFacts = {
  bubblewrap: "/usr/bin/bwrap",
  apparmorRestricted: true,
  apparmorProfile: undefined,
  container: false,
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kscan-sandbox-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function executable(path: string, script: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("sandbox diagnostics", () => {
  it("takes the sandbox's own line out of the Codex Security message", () => {
    expect(sandboxDiagnostic(REPORTED)).toBe(USERNS_DENIED);
    expect(
      sandboxDiagnostic(
        `WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)\r\n\n${USERNS_DENIED}\n`,
      ),
    ).toBe(USERNS_DENIED);
    expect(sandboxDiagnostic("Codex sandbox probe timed out after 10 seconds.")).toBe(
      "Codex sandbox probe timed out after 10 seconds.",
    );
  });

  it("keeps other output on one bounded line", () => {
    const panic = [
      "Codex could not run a command in its sandbox: ",
      "thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:385:9:",
      "filesystem-restricted execution requires bubblewrap \u001b[31mto isolate app-server sockets",
      "To reproduce, run 'codex sandbox -- codex --version'.",
    ].join("\n");
    expect(sandboxDiagnostic(panic)).toBe(
      "thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:385:9: filesystem-restricted execution requires bubblewrap [31mto isolate app-server sockets",
    );
    expect(sandboxDiagnostic(`bwrap: ${"x".repeat(500)}`)).toHaveLength(300);
    expect(sandboxDiagnostic("")).toBe("");
  });
});

describe("host facts", () => {
  it("reads what decides whether Bubblewrap may create user namespaces", async () => {
    const root = join(directory, "root");
    await mkdir(join(root, "proc/sys/kernel"), { recursive: true });
    await writeFile(join(root, "proc/sys/kernel/apparmor_restrict_unprivileged_userns"), "1\n");
    await mkdir(join(root, "etc/apparmor.d"), { recursive: true });
    await writeFile(join(root, "etc/apparmor.d/bwrap-userns-restrict"), "profile bwrap {}\n");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(join(root, "run/.containerenv"), "");

    const first = join(directory, "first");
    const second = join(directory, "second");
    await mkdir(join(first, "bwrap"), { recursive: true });
    await mkdir(second);
    await executable(join(second, "bwrap"), "exit 0");
    const path = ["relative", join(directory, "missing"), first, second].join(delimiter);

    expect(await readSandboxFacts({ PATH: path }, root)).toEqual({
      bubblewrap: join(second, "bwrap"),
      apparmorRestricted: true,
      apparmorProfile: join(root, "etc/apparmor.d/bwrap-userns-restrict"),
      container: true,
    });

    await writeFile(join(root, "etc/apparmor.d/bwrap"), "profile bwrap {}\n");
    await writeFile(join(root, "proc/sys/kernel/apparmor_restrict_unprivileged_userns"), "0\n");
    await chmod(join(second, "bwrap"), 0o644);
    expect(await readSandboxFacts({ PATH: path }, root)).toMatchObject({
      bubblewrap: undefined,
      apparmorRestricted: false,
      apparmorProfile: join(root, "etc/apparmor.d/bwrap"),
    });
  });

  it("finds nothing on a host without them", async () => {
    expect(await readSandboxFacts({}, join(directory, "empty"))).toEqual({
      bubblewrap: undefined,
      apparmorRestricted: false,
      apparmorProfile: undefined,
      container: false,
    });
  });
});

describe("sandbox diagnosis", () => {
  const steps = `Steps: ${SANDBOX_HELP_URL}`;

  it("names the missing AppArmor profile on Ubuntu", () => {
    expect(diagnoseSandbox(USERNS_DENIED, UBUNTU, "linux")).toEqual({
      cause: "user_namespaces",
      problem: "can't create user namespaces",
      diagnostic: USERNS_DENIED,
      reason:
        "AppArmor restricts unprivileged user namespaces here, and /usr/bin/bwrap has no profile that allows them.",
      fix: `Add an AppArmor profile for /usr/bin/bwrap, then reload AppArmor. ${steps}`,
      next: [{ label: "Check the sandbox again", argv: ["kongyo-scan", "doctor"] }],
    });
  });

  it("tells apart what is missing when AppArmor restricts user namespaces", () => {
    const diagnose = (facts: Partial<SandboxFacts>, diagnostic = USERNS_DENIED) =>
      diagnoseSandbox(diagnostic, { ...UBUNTU, ...facts }, "linux");

    const unloaded = diagnose(
      { bubblewrap: "/usr/local/bin/bwrap", apparmorProfile: "/etc/apparmor.d/bwrap" },
      "bwrap: setting up uid map: Permission denied",
    );
    expect(unloaded.reason).toBe(
      "AppArmor restricts unprivileged user namespaces here, and the profile in /etc/apparmor.d/bwrap isn't in effect for /usr/local/bin/bwrap.",
    );
    expect(unloaded.fix).toBe(
      `Reload AppArmor with sudo systemctl reload apparmor, and check that the profile names that path. ${steps}`,
    );

    const bundled = diagnose({ bubblewrap: undefined });
    expect(bundled.reason).toBe(
      "AppArmor restricts unprivileged user namespaces here, and Bubblewrap isn't installed.",
    );
    expect(bundled.fix).toBe(
      `Install the bubblewrap package, then add an AppArmor profile for /usr/bin/bwrap. ${steps}`,
    );

    const newerUbuntu = diagnose({
      bubblewrap: undefined,
      apparmorProfile: "/etc/apparmor.d/bwrap-userns-restrict",
    });
    expect(newerUbuntu.reason).toBe(
      "AppArmor allows user namespaces only for /usr/bin/bwrap here, and Bubblewrap isn't installed.",
    );
    expect(newerUbuntu.fix).toBe(`Install the bubblewrap package. ${steps}`);
  });

  it("points a container and other kernels at their own fix", () => {
    const container = diagnoseSandbox(USERNS_DENIED, { ...UBUNTU, container: true }, "linux");
    expect(container).toMatchObject({
      cause: "user_namespaces",
      reason: "This is a container, and its runtime doesn't let Bubblewrap create user namespaces.",
      fix: `Scan on the host, or let the container create user namespaces. ${steps}`,
    });

    for (const diagnostic of [
      "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.",
      "bwrap: No permissions to creating new namespace, likely because the kernel does not allow non-privileged user namespaces.",
      "bwrap: Creating new namespace failed: nesting depth or /proc/sys/user/max_*_namespaces exceeded (ENOSPC)",
      "bwrap: loopback: Failed RTM_NEWLINK: Operation not permitted",
    ]) {
      expect(
        diagnoseSandbox(diagnostic, { ...UBUNTU, apparmorRestricted: false }, "linux"),
      ).toMatchObject({
        cause: "user_namespaces",
        reason: undefined,
        fix: `Allow unprivileged user namespaces for Bubblewrap. ${steps}`,
      });
    }
  });

  it("does not guess at other failures or other platforms", () => {
    expect(diagnoseSandbox("bwrap: Can't find source path /nope", UBUNTU, "linux")).toEqual({
      cause: "unknown",
      problem: "isn't available",
      diagnostic: "bwrap: Can't find source path /nope",
      reason: undefined,
      fix: `See what the sandbox needs: ${SANDBOX_HELP_URL}`,
      next: [{ label: "Check the sandbox again", argv: ["kongyo-scan", "doctor"] }],
    });
    expect(diagnoseSandbox(USERNS_DENIED, UBUNTU, "darwin")).toMatchObject({
      cause: "unknown",
      problem: "isn't available",
      fix: undefined,
    });
  });
});

describe("sandbox help", () => {
  it("links to a section that both READMEs have", async () => {
    const fragment = new URL(SANDBOX_HELP_URL).hash.slice(1);
    const english = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const anchors = [...english.matchAll(/^#{2,3} (.+)$/gmu)].map((heading) =>
      heading[1]!
        .toLowerCase()
        .replaceAll(/[^a-z0-9 -]/gu, "")
        .replaceAll(" ", "-"),
    );
    expect(anchors).toContain(fragment);
    const japanese = await readFile(new URL("../../README.ja.md", import.meta.url), "utf8");
    expect(japanese).toContain(`<a id="${fragment}"></a>`);
  });
});

describe("scan error", () => {
  it("replaces the container advice with the cause and the fix for this machine", () => {
    const error = sandboxUnavailableError(new Error(REPORTED), UBUNTU, "linux");
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      "Can't start the scan. The command sandbox can't create user namespaces on this machine.",
    );
    expect(error).toMatchObject({
      errorClass: "platform",
      reason: "unsupported_runtime",
      exitCode: 1,
      details: [
        USERNS_DENIED,
        "AppArmor restricts unprivileged user namespaces here, and /usr/bin/bwrap has no profile that allows them.",
      ],
      hint: `Add an AppArmor profile for /usr/bin/bwrap, then reload AppArmor. Steps: ${SANDBOX_HELP_URL}`,
      next: [{ label: "Check the sandbox again", argv: ["kongyo-scan", "doctor"] }],
      data: {
        sandbox: {
          cause: "user_namespaces",
          diagnostic: USERNS_DENIED,
          reason:
            "AppArmor restricts unprivileged user namespaces here, and /usr/bin/bwrap has no profile that allows them.",
          fix: `Add an AppArmor profile for /usr/bin/bwrap, then reload AppArmor. Steps: ${SANDBOX_HELP_URL}`,
        },
      },
    });
    const shown = [error.message, ...error.details, error.hint].join("\n");
    expect(shown).not.toMatch(/Compose|container image|To reproduce/u);
  });

  it("keeps to what the sandbox said where it has nothing to add", () => {
    const error = sandboxUnavailableError(new Error(REPORTED), UBUNTU, "darwin");
    expect(error.message).toBe(
      "Can't start the scan. The command sandbox isn't available on this machine.",
    );
    expect(error.details).toEqual([USERNS_DENIED]);
    expect(error.hint).toBeUndefined();
    expect(error.data).toEqual({
      sandbox: { cause: "unknown", diagnostic: USERNS_DENIED, reason: null, fix: null },
    });
  });
});

describe.skipIf(process.platform === "win32")("sandbox probe", () => {
  it("runs one command in the Codex sandbox with the home a scan uses", async () => {
    const log = join(directory, "calls.log");
    const codex = await executable(
      join(directory, "codex"),
      `printf '%s\\n' "$CODEX_HOME" "$*" >> '${log}'`,
    );
    const home = sandboxCodexHome({
      home: directory,
      configFile: join(directory, "config.json"),
      stateDir: join(directory, "state"),
      codexHome: join(directory, "codex-home"),
      credentialsFile: join(directory, "state", "codex-home", "kongyo-scan-credentials.json"),
      historyFile: join(directory, "history.jsonl"),
    });
    expect(home).toBe(join(directory, "state", "codex-home"));

    expect(
      await probeSandbox(
        { command: codex, args: ["-c", "x=1"] },
        { PATH: process.env["PATH"] },
        home,
      ),
    ).toBeUndefined();
    expect((await readFile(log, "utf8")).split("\n")).toEqual([
      home,
      `-c x=1 sandbox -- ${codex} --version`,
      "",
    ]);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("reports why the sandbox did not start", async () => {
    const env = { PATH: process.env["PATH"] };
    const home = join(directory, "home");
    const denied = await executable(
      join(directory, "denied"),
      `echo "WARNING: proceeding, even though we could not create PATH aliases: Permission denied (os error 13)" >&2\necho "${USERNS_DENIED}" >&2\nexit 1`,
    );
    expect(await probeSandbox({ command: denied }, env, home)).toBe(USERNS_DENIED);

    const silent = await executable(join(directory, "silent"), "exit 7");
    expect(await probeSandbox({ command: silent }, env, home)).toBe("Codex exited with status 7.");

    const stdout = await executable(join(directory, "stdout"), "echo sandbox is off; exit 1");
    expect(await probeSandbox({ command: stdout }, env, home)).toBe("sandbox is off");

    expect(await probeSandbox({ command: join(directory, "missing") }, env, home)).toMatch(
      /ENOENT/u,
    );
  });

  it("stops waiting when the sandbox hangs or the check is canceled", async () => {
    const env = { PATH: process.env["PATH"] };
    const home = join(directory, "home");
    const hanging = await executable(join(directory, "hanging"), "exec sleep 30");
    const started = Date.now();
    expect(await probeSandbox({ command: hanging }, env, home, { timeoutMs: 200 })).toBe(
      "The sandbox didn't answer within 0.2 seconds.",
    );

    const controller = new AbortController();
    const pending = probeSandbox({ command: hanging }, env, home, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toBe("The sandbox check was stopped.");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
