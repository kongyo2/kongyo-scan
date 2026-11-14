import { describe, expect, it } from "vitest";

import type { AppContext } from "../../src/app/context.js";
import { type CommandSpec, parseInvocation, splitList } from "../../src/cli/args.js";
import {
  formatAge,
  formatClock,
  formatDuration,
  formatTokens,
  formatTokensShort,
  formatUsd,
  plural,
} from "../../src/cli/format.js";
import { helpDocument, renderHelp } from "../../src/cli/help.js";
import { formatCommand, shellQuote } from "../../src/cli/output.js";
import { resolveTerminal } from "../../src/cli/terminal.js";
import { createTheme, displayWidth, stripAnsi, truncate } from "../../src/cli/theme.js";
import { rootCommand } from "../../src/commands/root.js";
import { CliError } from "../../src/core/errors.js";
import { closest } from "../../src/core/suggest.js";

function parse(argv: string[]): ReturnType<typeof parseInvocation<AppContext>> {
  return parseInvocation(rootCommand, argv);
}

function failure(argv: string[]): CliError {
  try {
    parse(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error(`expected ${argv.join(" ")} to fail`);
}

describe("parseInvocation", () => {
  it("resolves command paths, aliases, and options in any position", () => {
    const scan = parse([
      "--debug",
      "scan",
      "repo",
      "--path",
      "src,tests",
      "--path=docs",
      "--mode",
      "deep",
      "--no-fallback",
      "--max-time=15",
      "-o",
      "out",
    ]);
    expect(scan.path).toBe("kongyo-scan scan");
    expect(scan.args.positionals).toEqual(["repo"]);
    expect(scan.args.values).toMatchObject({
      debug: true,
      path: ["src", "tests", "docs"],
      mode: "deep",
      fallback: false,
      "max-time": 15,
      output: "out",
    });
    expect(parse(["provider", "ls"]).path).toBe("kongyo-scan providers list");
    expect(parse(["providers", "rm", "x"]).path).toBe("kongyo-scan providers remove");
    expect(parse([]).bare).toBe(true);
    expect(parse(["--no-color"]).bare).toBe(true);
    expect(parse(["scan"]).bare).toBe(false);
  });

  it("accepts the boolean spellings --x=true and --x=false", () => {
    expect(parse(["scan", "--working-tree=true"]).args.values["working-tree"]).toBe(true);
    expect(parse(["scan", "--working-tree=false"]).args.values["working-tree"]).toBe(false);
    expect(parse(["scan", "--non-interactive=false"]).args.values["non-interactive"]).toBe(false);
    expect(parse(["scan", "--json"]).args.values["json"]).toBe(true);
  });

  it("detects help before validating anything else", () => {
    const help = parse(["providers", "add", "--bogus", "--help"]);
    expect(help.help).toBe(true);
    expect(help.path).toBe("kongyo-scan providers add");
    expect(parse(["-h"]).help).toBe(true);
    expect(parse(["scan", "--version"]).version).toBe(true);
  });

  it("fails on unknown commands and options with one close suggestion", () => {
    const option = failure(["scan", "--pth", "src"]);
    expect(option.message).toBe("Unknown option --pth for kongyo-scan scan. Did you mean --path?");
    expect(option.reason).toBe("unknown_option");
    expect(option.exitCode).toBe(2);
    expect(option.next[0]!.argv).toEqual(["kongyo-scan", "scan", "--help"]);

    const command = failure(["providers", "ad"]);
    expect(command.message).toBe("Unknown command ad for kongyo-scan providers. Did you mean add?");
    expect(command.reason).toBe("unknown_command");
    expect(failure(["frobnicate"]).message).toBe("Unknown command frobnicate for kongyo-scan.");
    expect(failure(["sca"]).reason).toBe("unknown_command");
  });

  it("rejects bad values and extra arguments before any work", () => {
    expect(failure(["scan", "--mode", "turbo"]).message).toContain("Use standard or deep.");
    expect(failure(["scan", "--max-time", "soon"]).message).toContain("must be a number");
    expect(failure(["scan", "--path"]).message).toContain("needs a value");
    expect(failure(["scan", "a", "b"]).message).toContain("takes at most 1 argument");
    expect(failure(["doctor", "extra"]).message).toContain("takes no arguments");
    expect(failure(["scan", "--fail-on-severity", "hgih"]).message).toContain("Did you mean high?");
  });

  it("hands everything after a passthrough command to the child untouched", () => {
    const plain = parse(["codex-security", "scans", "show", "--json"]);
    expect(plain.args.rest).toEqual(["scans", "show", "--json"]);
    expect(parse(["cs", "--", "--help"]).args.rest).toEqual(["--help"]);
    expect(parse(["--home", "/tmp/x", "cs", "export", "--output", "a b"]).args.rest).toEqual([
      "export",
      "--output",
      "a b",
    ]);
    expect(parse(["codex-security", "--help"]).args.rest).toEqual(["--help"]);
  });

  it("keeps literal arguments after --", () => {
    expect(parse(["scan", "--", "--weird-dir"]).args.rest).toEqual(["--weird-dir"]);
  });
});

describe("list and suggestion helpers", () => {
  it("splits lists on commas with an escape for literal commas", () => {
    expect(splitList("a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(splitList("dir\\,with\\,commas,other")).toEqual(["dir,with,commas", "other"]);
  });

  it("suggests only close matches", () => {
    expect(closest("--prdo", ["--prod", "--project"])).toBe("--prod");
    expect(closest("xyz", ["scan", "config"])).toBeUndefined();
  });
});

describe("help", () => {
  const theme = createTheme(false, false);

  it("renders every command from the same metadata, with sections in order", () => {
    const visit = (chain: CommandSpec<AppContext>[]): void => {
      const text = renderHelp(chain, theme, 80);
      const path = chain.map((command) => command.name).join(" ");
      expect(text.startsWith(path), path).toBe(true);
      expect(text).toContain("Learn more: https://www.npmjs.com/package/@kongyo2/kongyo-scan");
      const order = [
        "Commands:",
        "Arguments:",
        "Options:",
        "Global Options:",
        "Examples:",
        "Notes:",
        "Learn more:",
      ]
        .map((heading) => text.search(new RegExp(`^${heading}`, "mu")))
        .filter((index) => index >= 0);
      expect(order, path).toEqual([...order].sort((a, b) => a - b));
      for (const line of text.split("\n"))
        expect(displayWidth(line), `${path}: ${line}`).toBeLessThanOrEqual(100);
      for (const child of chain.at(-1)!.subcommands ?? []) visit([...chain, child]);
    };
    visit([rootCommand]);
  });

  it("lists options alphabetically and documents defaults and negations", () => {
    const scan = rootCommand.subcommands!.find((command) => command.name === "scan")!;
    const text = renderHelp([rootCommand, scan], theme, 100);
    const names = [...text.matchAll(/^ {2}(?:-\w, )?--([a-z-]+)/gmu)].map((match) =>
      match[1]!.replace(/^no-/u, ""),
    );
    const options = names.slice(0, names.indexOf("config") + 1);
    expect(options).toEqual([...options].sort((a, b) => a.localeCompare(b)));
    expect(text).toContain("--no-fallback");
    expect(text).toContain("(default: standard)");
    expect(text).toContain("Global Options: See `kongyo-scan --help`");
  });

  it("every example parses against the current command metadata", () => {
    const visit = (chain: CommandSpec<AppContext>[]): void => {
      for (const example of chain.at(-1)!.examples ?? []) {
        const argv = example.argv
          .slice(1)
          .map((argument) => argument.replaceAll(/<[A-Z_=]+>/gu, "value"));
        expect(() => parseInvocation(rootCommand, argv), example.argv.join(" ")).not.toThrow();
      }
      for (const child of chain.at(-1)!.subcommands ?? []) visit([...chain, child]);
    };
    visit([rootCommand]);
  });

  it("describes a command as one JSON document", () => {
    const providers = rootCommand.subcommands!.find((command) => command.name === "providers")!;
    const add = providers.subcommands!.find((command) => command.name === "add")!;
    const document = helpDocument([rootCommand, providers, add]);
    expect(document["path"]).toBe("kongyo-scan providers add");
    const options = document["options"] as { name: string; type: string; choices?: string[] }[];
    expect(options.find((option) => option.name === "--wire-api")).toMatchObject({
      type: "string",
      choices: ["responses", "chat"],
    });
    expect(
      (
        helpDocument([rootCommand, providers])["subcommands"] as {
          name: string;
          default?: boolean;
        }[]
      ).find((command) => command.default)?.name,
    ).toBe("list");
  });
});

describe("terminal modes", () => {
  const tty = { isTTY: true, columns: 120, write: () => true };
  const pipe = { isTTY: false, write: () => true };

  it("allows prompts only on a real terminal with no machine or automation signal", () => {
    expect(resolveTerminal({}, {}, { stdin: tty, stdout: tty, stderr: tty }).interactive).toBe(
      true,
    );
    expect(resolveTerminal({}, {}, { stdin: tty, stdout: pipe, stderr: tty }).interactive).toBe(
      true,
    );
    expect(
      resolveTerminal({ json: true }, {}, { stdin: tty, stdout: tty, stderr: tty }),
    ).toMatchObject({ interactive: false, nonInteractiveReason: "--json" });
    expect(
      resolveTerminal({}, { CI: "true" }, { stdin: tty, stdout: tty, stderr: tty }).interactive,
    ).toBe(false);
    expect(resolveTerminal({}, {}, { stdin: pipe, stdout: tty, stderr: tty }).interactive).toBe(
      false,
    );
    expect(
      resolveTerminal({ nonInteractive: true }, {}, { stdin: tty, stdout: tty, stderr: tty })
        .interactive,
    ).toBe(false);
    const agent = { CLAUDECODE: "1" };
    expect(resolveTerminal({}, agent, { stdin: tty, stdout: tty, stderr: tty }).interactive).toBe(
      false,
    );
    expect(
      resolveTerminal({ nonInteractive: false }, agent, { stdin: tty, stdout: tty, stderr: tty })
        .interactive,
    ).toBe(true);
  });

  it("resolves color per stream with the documented precedence", () => {
    const streams = { stdin: tty, stdout: pipe, stderr: tty };
    expect(resolveTerminal({}, {}, streams)).toMatchObject({
      stdoutColor: false,
      stderrColor: true,
      stdoutRich: false,
      stderrRich: true,
    });
    expect(resolveTerminal({ noColor: true }, { FORCE_COLOR: "1" }, streams).stderrColor).toBe(
      false,
    );
    expect(resolveTerminal({}, { NO_COLOR: "1", FORCE_COLOR: "1" }, streams).stderrColor).toBe(
      false,
    );
    expect(resolveTerminal({}, { FORCE_COLOR: "1" }, streams).stdoutColor).toBe(true);
    expect(resolveTerminal({}, { FORCE_COLOR: "0" }, streams).stderrColor).toBe(false);
    expect(
      resolveTerminal({}, { TERM: "dumb" }, { stdin: tty, stdout: tty, stderr: tty }),
    ).toMatchObject({ stdoutColor: false, stdoutRich: false });
    expect(resolveTerminal({ json: true }, { FORCE_COLOR: "1" }, streams).stdoutColor).toBe(false);
  });
});

describe("formatting", () => {
  it("quotes commands so they can be pasted into a shell", () => {
    expect(shellQuote("plain-value_1.0")).toBe("plain-value_1.0");
    expect(shellQuote("has space")).toBe("'has space'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(formatCommand(["kongyo-scan", "scan", "--path", "my dir"])).toBe(
      "kongyo-scan scan --path 'my dir'",
    );
  });

  it("formats durations, counts, money, ages, and tokens", () => {
    expect([
      formatDuration(42),
      formatDuration(3400),
      formatDuration(41_000),
      formatDuration(130_000),
      formatDuration(3_900_000),
    ]).toEqual(["42ms", "3.4s", "41s", "2m 10s", "1h 5m"]);
    expect([formatClock(7000), formatClock(765_000), formatClock(3_723_000)]).toEqual([
      "0:07",
      "12:45",
      "1:02:03",
    ]);
    expect([plural(0, "finding"), plural(1, "finding"), plural(1234, "finding")]).toEqual([
      "No findings",
      "1 finding",
      "1,234 findings",
    ]);
    expect([formatUsd(20), formatUsd(0.4), formatUsd(0.0031)]).toEqual([
      "$20.00",
      "$0.40",
      "$0.0031",
    ]);
    const now = new Date("2026-11-14T12:00:00Z");
    expect([
      formatAge("2026-11-14T11:58:00Z", now),
      formatAge("2026-11-14T07:00:00Z", now),
      formatAge("2026-11-11T12:00:00Z", now),
    ]).toEqual(["2m", "5h", "3d"]);
    expect(formatAge("2026-03-05T12:00:00Z", now)).toMatch(/^Mar \d, 2026$/u);
    expect(
      formatTokens({
        inputTokens: 545_551,
        cachedInputTokens: 492_944,
        outputTokens: 15_049,
        reasoningTokens: 0,
        totalTokens: 560_600,
        estimated: false,
      }),
    ).toBe("545,551 in (492,944 cached), 15,049 out");
    expect([
      formatTokensShort(950),
      formatTokensShort(15_049),
      formatTokensShort(545_551),
      formatTokensShort(2_959_865),
    ]).toEqual(["950", "15.0K", "546K", "3.0M"]);
  });

  it("measures and truncates by display width", () => {
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth(createTheme(true, true).bold("abc"))).toBe(3);
    expect(stripAnsi(createTheme(true, true).danger("x"))).toBe("x");
    expect(truncate("abcdefghij", 6)).toBe("abcde…");
    expect(truncate("short", 10)).toBe("short");
  });
});
