import type { AppContext } from "../app/context.js";
import { booleanOption, type CommandSpec, findSubcommand, type ParsedArgs } from "../cli/args.js";
import { allHelpDocuments, helpDocument, renderHelp } from "../cli/help.js";
import { CliError } from "../core/errors.js";
import { BIN } from "../version.js";
import { configCommand, initCommand } from "./config.js";
import { doctorCommand } from "./doctor.js";
import { passthroughCommand } from "./passthrough.js";
import { providersCommand } from "./providers.js";
import { scanCommand } from "./scan.js";
import { scansCommand } from "./scans.js";

async function help(context: AppContext, args: ParsedArgs): Promise<number> {
  const { output, terminal } = context;
  if (booleanOption(args, "all")) {
    if (!terminal.json) {
      throw new CliError("usage", "Can't use --all without --json.", {
        reason: "invalid_arguments",
        next: [{ label: "Print every command as JSON", argv: [BIN, "help", "--all", "--json"] }],
      });
    }
    output.json({ commands: allHelpDocuments(rootCommand) });
    return 0;
  }
  const chain: CommandSpec<AppContext>[] = [rootCommand];
  for (const token of args.positionals) {
    const child = findSubcommand(chain.at(-1)!, token);
    if (!child) {
      const path = chain.map((command) => command.name).join(" ");
      throw new CliError("usage", `Unknown command ${token} for ${path}.`, {
        reason: "unknown_command",
        next: [{ label: "See the available commands", argv: [...path.split(" "), "--help"] }],
      });
    }
    chain.push(child);
  }
  if (terminal.json) output.json(helpDocument(chain));
  else output.write(renderHelp(chain, output.out, terminal.stdoutColumns));
  return 0;
}

const helpCommand: CommandSpec<AppContext> = {
  name: "help",
  group: "Advanced",
  summary: "Show help for a command",
  arguments: [
    { name: "command", description: "Command path, such as providers add", variadic: true },
  ],
  options: [
    { name: "all", type: "boolean", description: "With --json, print every command" },
    { name: "json", type: "boolean", description: "Output the help as JSON" },
  ],
  run: help,
};

export const rootCommand: CommandSpec<AppContext> = {
  name: BIN,
  summary: "Scan your repositories with Codex Security on any OpenAI-compatible model endpoint",
  subcommands: [
    scanCommand,
    scansCommand,
    providersCommand,
    configCommand,
    initCommand,
    doctorCommand,
    passthroughCommand,
    helpCommand,
  ],
  examples: [
    { label: "Open the interactive UI", argv: [BIN] },
    {
      label: "Add a model provider, then scan the current repository",
      argv: [BIN, "providers", "add"],
    },
    { label: "Scan without prompts and read the result", argv: [BIN, "scan", "--json"] },
  ],
  notes: [
    "Run without a command in a terminal to open the interactive UI.",
    "Scans run on this machine through Codex Security. Model requests go to the providers you configure, in fallback order; no OpenAI sign-in is involved.",
  ],
};
