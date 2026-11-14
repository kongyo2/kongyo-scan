import { parseArgs, type ParseArgsConfig } from "node:util";

import { CliError, usageError } from "../core/errors.js";
import { closest } from "../core/suggest.js";
import { BIN } from "../version.js";

export type OptionType = "boolean" | "string" | "number" | "list";

export interface OptionSpec {
  name: string;
  short?: string;
  type: OptionType;
  hint?: string;
  description: string;
  choices?: readonly string[];
  defaultText?: string;
  negated?: boolean;
  hidden?: boolean;
}

export interface ArgumentSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export interface ExampleSpec {
  label: string;
  argv: readonly string[];
}

export interface CommandSpec<Context = unknown> {
  name: string;
  summary: string;
  aliases?: readonly string[];
  hidden?: boolean;
  group?: string;
  arguments?: readonly ArgumentSpec[];
  options?: readonly OptionSpec[];
  examples?: readonly ExampleSpec[];
  notes?: readonly string[];
  subcommands?: readonly CommandSpec<Context>[];
  defaultSubcommand?: string;
  passthrough?: boolean;
  run?: (context: Context, args: ParsedArgs) => Promise<number | void>;
}

export interface ParsedArgs {
  values: Readonly<Record<string, string | number | boolean | string[] | undefined>>;
  positionals: readonly string[];
  rest: readonly string[];
}

export interface Invocation<Context = unknown> {
  chain: readonly CommandSpec<Context>[];
  command: CommandSpec<Context>;
  path: string;
  help: boolean;
  version: boolean;
  args: ParsedArgs;
  bare: boolean;
}

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: "help",
    short: "h",
    type: "boolean",
    description: "Show help for the selected command; do no work",
  },
  { name: "version", short: "v", type: "boolean", description: "Print the CLI version" },
  {
    name: "debug",
    short: "d",
    type: "boolean",
    description: "Redacted diagnostic detail on stderr",
  },
  { name: "color", type: "boolean", negated: true, description: "Disable color" },
  {
    name: "non-interactive",
    type: "boolean",
    description: "Never prompt; fail with the required inputs instead",
  },
  {
    name: "home",
    type: "string",
    hint: "<DIR>",
    description: "Directory for config and scan state",
    defaultText: "KONGYO_SCAN_HOME, otherwise ~/.kongyo-scan",
  },
];

export function findSubcommand<Context>(
  command: CommandSpec<Context>,
  token: string,
): CommandSpec<Context> | undefined {
  return command.subcommands?.find(
    (child) => child.name === token || child.aliases?.includes(token),
  );
}

function optionMap(specs: readonly OptionSpec[]): Map<string, OptionSpec> {
  const map = new Map<string, OptionSpec>();
  for (const spec of specs) {
    map.set(`--${spec.name}`, spec);
    if (spec.short) map.set(`-${spec.short}`, spec);
  }
  return map;
}

export function splitList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\\" && value[index + 1] === ",") {
      current += ",";
      index++;
    } else if (character === ",") {
      items.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

const JSON_FLAG: OptionSpec = { name: "json", type: "boolean", description: "Output as JSON" };

function helpStep(path: string): { label: string; argv: string[] } {
  return { label: "See all options", argv: [...path.split(" "), "--help"] };
}

export function parseInvocation<Context>(
  root: CommandSpec<Context>,
  argv: readonly string[],
): Invocation<Context> {
  const globals = optionMap(GLOBAL_OPTIONS);
  const chain: CommandSpec<Context>[] = [root];
  let command = root;
  const remaining: string[] = [];
  let rest: string[] = [];
  let bare = true;
  let sawPositional = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") {
      rest = argv.slice(index + 1);
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      remaining.push(token);
      const spec = globals.get(token) ?? optionMap(command.options ?? []).get(token);
      if (spec && spec.type !== "boolean" && !token.includes("=") && index + 1 < argv.length) {
        remaining.push(argv[++index]!);
      }
      continue;
    }
    const child = sawPositional ? undefined : findSubcommand(command, token);
    if (child) {
      bare = false;
      chain.push(child);
      command = child;
      if (child.passthrough) {
        const tail = argv.slice(index + 1);
        rest = tail[0] === "--" ? tail.slice(1) : tail;
        break;
      }
      continue;
    }
    if (command.subcommands && command.subcommands.length > 0 && !command.run && !sawPositional) {
      bare = false;
      const path = chain.map((item) => item.name).join(" ");
      const names = command.subcommands.filter((item) => !item.hidden).map((item) => item.name);
      const suggestion = closest(token, names);
      throw new CliError(
        "usage",
        `Unknown command ${token} for ${path}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
        {
          reason: "unknown_command",
          next: [{ label: "See the available commands", argv: [...path.split(" "), "--help"] }],
          ...(suggestion ? { data: { suggestion } } : {}),
        },
      );
    }
    bare = false;
    sawPositional = true;
    remaining.push(token);
  }

  const path = chain.map((item) => item.name).join(" ");
  if (command.passthrough) {
    const leading = parseKnown(remaining, GLOBAL_OPTIONS, path, true);
    return {
      chain,
      command,
      path,
      help: leading.values["help"] === true && rest.length === 0,
      version: false,
      args: { values: leading.values, positionals: [], rest },
      bare: false,
    };
  }

  const specs = [...GLOBAL_OPTIONS, ...(command.options ?? [])];
  const informational = specs.some((spec) => spec.name === "json") ? specs : [...specs, JSON_FLAG];
  if (remaining.some((token) => token === "--help" || token === "-h")) {
    const lenient = parseKnown(remaining, informational, path, true);
    return { chain, command, path, help: true, version: false, args: { ...lenient, rest }, bare };
  }
  if (remaining.some((token) => token === "--version" || token === "-v")) {
    const lenient = parseKnown(remaining, informational, path, true);
    if (lenient.values["version"] === true) {
      return { chain, command, path, help: false, version: true, args: { ...lenient, rest }, bare };
    }
  }
  const parsed = parseKnown(remaining, specs, path, false);
  validatePositionals(command, parsed.positionals, path);
  return {
    chain,
    command,
    path,
    help: false,
    version: false,
    args: { ...parsed, rest },
    bare: bare && parsed.positionals.length === 0,
  };
}

function parseKnown(
  tokens: readonly string[],
  specs: readonly OptionSpec[],
  path: string,
  lenient: boolean,
): {
  values: Record<string, string | number | boolean | string[] | undefined>;
  positionals: string[];
} {
  const byFlag = optionMap(specs);
  const booleans = new Set(
    specs.filter((spec) => spec.type === "boolean").map((spec) => spec.name),
  );
  const normalized = tokens.map((token) => {
    const match = /^--(no-)?([a-z0-9-]+)=(true|false)$/u.exec(token);
    if (!match || !booleans.has(match[2]!)) return token;
    const on = (match[3] === "true") !== (match[1] !== undefined);
    return on ? `--${match[2]}` : `--no-${match[2]}`;
  });

  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const spec of specs) {
    options[spec.name] = {
      type: spec.type === "boolean" ? "boolean" : "string",
      ...(spec.short ? { short: spec.short } : {}),
      ...(spec.type === "list" ? { multiple: true } : {}),
    };
  }

  let result: ReturnType<typeof parseArgs>;
  try {
    result = parseArgs({
      args: normalized,
      options,
      allowPositionals: true,
      allowNegative: true,
      strict: !lenient,
    });
  } catch (error) {
    throw translateParseError(error, specs, path);
  }

  const values: Record<string, string | number | boolean | string[] | undefined> = {};
  for (const spec of specs) {
    const raw = (result.values as Record<string, unknown>)[spec.name];
    if (raw === undefined) continue;
    if (spec.type === "boolean") {
      if (typeof raw === "boolean") values[spec.name] = raw;
      continue;
    }
    if (spec.type === "list") {
      const items = (Array.isArray(raw) ? raw : [raw]).flatMap((item) =>
        typeof item === "string" ? splitList(item) : [],
      );
      if (!lenient) {
        if (items.length === 0)
          throw usageError(`Option --${spec.name} needs a value.`, { next: [helpStep(path)] });
        for (const item of items) checkChoice(spec, item, path);
      }
      values[spec.name] = items;
      continue;
    }
    if (typeof raw !== "string") continue;
    if (!lenient && raw.trim() === "") {
      throw usageError(`Option --${spec.name} needs a value.`, { next: [helpStep(path)] });
    }
    if (spec.type === "number") {
      const number = Number(raw);
      if (!lenient && (raw.trim() === "" || !Number.isFinite(number))) {
        throw usageError(`Can't use --${spec.name} ${raw}. It must be a number.`, {
          next: [helpStep(path)],
        });
      }
      values[spec.name] = number;
      continue;
    }
    if (!lenient) checkChoice(spec, raw, path);
    values[spec.name] = raw;
  }
  void byFlag;
  return { values, positionals: result.positionals };
}

function checkChoice(spec: OptionSpec, value: string, path: string): void {
  if (!spec.choices || spec.choices.includes(value)) return;
  const suggestion = closest(value, spec.choices);
  throw usageError(
    `Can't use --${spec.name} ${value}. Use ${formatChoices(spec.choices)}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
    { next: [helpStep(path)], data: { accepted: [...spec.choices] } },
  );
}

function formatChoices(choices: readonly string[]): string {
  if (choices.length <= 1) return choices.join("");
  if (choices.length === 2) return `${choices[0]} or ${choices[1]}`;
  return `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}`;
}

function translateParseError(error: unknown, specs: readonly OptionSpec[], path: string): CliError {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const option = /Unknown option '([^']+)'/u.exec(message)?.[1] ?? "";
    const name = option.replace(/=.*$/u, "");
    const candidates = specs
      .filter((spec) => !spec.hidden)
      .flatMap((spec) => [
        `--${spec.name}`,
        ...(spec.type === "boolean" ? [`--no-${spec.name}`] : []),
      ]);
    const suggestion = name.startsWith("--") ? closest(name, candidates) : undefined;
    return new CliError(
      "usage",
      `Unknown option ${name} for ${path}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
      {
        reason: "unknown_option",
        next: [helpStep(path)],
        ...(suggestion ? { data: { suggestion } } : {}),
      },
    );
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const option = /'(-{1,2}[A-Za-z0-9-]+)/u.exec(message)?.[1];
    if (/argument missing/u.test(message) || /ambiguous/u.test(message)) {
      return usageError(`Option ${option ?? ""} needs a value.`.replace("  ", " "), {
        next: [helpStep(path)],
      });
    }
    return usageError(`Option ${option ?? ""} doesn't take a value.`.replace("  ", " "), {
      next: [helpStep(path)],
    });
  }
  return usageError(`Can't parse the arguments for ${path}. ${message}`, {
    next: [helpStep(path)],
  });
}

function validatePositionals<Context>(
  command: CommandSpec<Context>,
  positionals: readonly string[],
  path: string,
): void {
  const specs = command.arguments ?? [];
  const variadic = specs.some((spec) => spec.variadic);
  if (!variadic && positionals.length > specs.length) {
    const extra = positionals[specs.length]!;
    throw usageError(
      specs.length === 0
        ? `${path} takes no arguments, but got ${JSON.stringify(extra)}.`
        : `${path} takes at most ${specs.length} ${specs.length === 1 ? "argument" : "arguments"}, but got ${positionals.length}.`,
      { next: [helpStep(path)] },
    );
  }
}

export function requireArgument(
  args: ParsedArgs,
  index: number,
  name: string,
  path: string,
): string {
  const value = args.positionals[index];
  if (value === undefined || value.trim() === "") {
    throw new CliError("missing_input", `Can't run ${path} without <${name}>.`, {
      reason: "missing_input",
      next: [helpStep(path)],
    });
  }
  return value;
}

export function stringOption(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === "string" ? value : undefined;
}

export function numberOption(args: ParsedArgs, name: string): number | undefined {
  const value = args.values[name];
  return typeof value === "number" ? value : undefined;
}

export function booleanOption(args: ParsedArgs, name: string): boolean | undefined {
  const value = args.values[name];
  return typeof value === "boolean" ? value : undefined;
}

export function listOption(args: ParsedArgs, name: string): string[] | undefined {
  const value = args.values[name];
  return Array.isArray(value) ? value : undefined;
}

export const ROOT_NAME = BIN;
