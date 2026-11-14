import type { AppContext } from "./app/context.js";
import { booleanOption, type Invocation, parseInvocation, stringOption } from "./cli/args.js";
import { helpDocument, renderHelp } from "./cli/help.js";
import { Output } from "./cli/output.js";
import { resolveTerminal, type TerminalFlags } from "./cli/terminal.js";
import { rootCommand } from "./commands/root.js";
import { CanceledError, CliError } from "./core/errors.js";
import { resolvePaths } from "./core/paths.js";
import { BIN, VERSION } from "./version.js";

function quietExperimentalWarnings(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const name =
      typeof warning === "string"
        ? typeof rest[0] === "string"
          ? rest[0]
          : (rest[0] as { type?: string } | undefined)?.type
        : warning.name;
    const message = typeof warning === "string" ? warning : warning.message;
    if (name === "ExperimentalWarning" && /SQLite/u.test(message)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

function presentationFlags(argv: readonly string[]): TerminalFlags {
  const before = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
  return {
    json: before.includes("--json"),
    noColor: before.includes("--no-color"),
    debug: before.includes("--debug") || before.includes("-d"),
  };
}

function terminalFlags(invocation: Invocation<AppContext>): TerminalFlags {
  const { args } = invocation;
  return {
    json: booleanOption(args, "json") === true,
    nonInteractive: booleanOption(args, "non-interactive"),
    noColor: booleanOption(args, "color") === false,
    debug: booleanOption(args, "debug") === true,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  quietExperimentalWarnings();

  let invocation: Invocation<AppContext>;
  try {
    invocation = parseInvocation(rootCommand, argv);
  } catch (error) {
    return new Output(resolveTerminal(presentationFlags(argv))).fail(error, BIN);
  }

  const terminal = resolveTerminal(terminalFlags(invocation));
  const output = new Output(terminal);

  if (invocation.help) {
    if (terminal.json) output.json(helpDocument(invocation.chain));
    else output.write(renderHelp(invocation.chain, output.out, terminal.stdoutColumns));
    return 0;
  }
  if (invocation.version) {
    if (terminal.json) output.json({ version: VERSION });
    else output.line(VERSION);
    return 0;
  }

  const controller = new AbortController();
  let signalName: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted)
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    signalName = signal;
    controller.abort(new CanceledError("Nothing was changed.", signal));
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);

  try {
    const context: AppContext = {
      terminal,
      output,
      paths: resolvePaths(process.env, stringOption(invocation.args, "home")),
      env: process.env,
      cwd: process.cwd(),
      signal: controller.signal,
      abortSignalName: () => signalName,
    };

    if (invocation.bare) {
      if (!terminal.interactive) {
        throw new CliError(
          "missing_input",
          `Can't open the interactive UI without a terminal (${terminal.nonInteractiveReason}).`,
          {
            reason: "missing_input",
            next: [
              { label: "Scan the current repository", argv: [BIN, "scan"] },
              { label: "See every command", argv: [BIN, "--help"] },
            ],
          },
        );
      }
      const { runApp } = await import("./tui/app.js");
      return await runApp(context);
    }

    let command = invocation.command;
    if (!command.run && command.defaultSubcommand) {
      const fallback = command.subcommands?.find(
        (child) => child.name === command.defaultSubcommand,
      );
      if (fallback) command = fallback;
    }
    if (!command.run) {
      output.write(renderHelp(invocation.chain, output.out, terminal.stdoutColumns));
      return 0;
    }
    const code = await command.run(context, invocation.args);
    return typeof code === "number" ? code : 0;
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof CliError)) {
      return output.fail(
        error instanceof CanceledError
          ? error
          : new CanceledError("Nothing was changed.", signalName),
        invocation.path,
      );
    }
    return output.fail(error, invocation.path);
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const onPipeError = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EPIPE") process.exit(0);
  };
  process.stdout.on("error", onPipeError);
  process.stderr.on("error", onPipeError);
  const code = await main(argv);
  process.exitCode = code;
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}
