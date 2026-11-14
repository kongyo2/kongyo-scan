import { type CommandSpec, GLOBAL_OPTIONS, type OptionSpec } from "./args.js";
import { formatCommand } from "./output.js";
import { displayWidth, padEnd, type Theme, wrapText } from "./theme.js";

export const DOCS_URL = "https://www.npmjs.com/package/@kongyo2/kongyo-scan";

function usageLine<Context>(chain: readonly CommandSpec<Context>[]): string {
  const command = chain.at(-1)!;
  const parts = [chain.map((item) => item.name).join(" ")];
  if (command.passthrough) return `${parts[0]} [--] [arguments]...`;
  if (command.subcommands && command.subcommands.length > 0) {
    parts.push(
      command.run || command.defaultSubcommand || chain.length === 1 ? "[command]" : "<command>",
    );
  }
  for (const argument of command.arguments ?? []) {
    const name = argument.variadic ? `${argument.name}` : argument.name;
    const text = argument.required ? `<${name}>` : `[${name}]`;
    parts.push(argument.variadic ? `${text}...` : text);
  }
  parts.push("[options]");
  return parts.join(" ");
}

function optionSyntax(spec: OptionSpec): string {
  const long = spec.negated ? `--no-${spec.name}` : `--${spec.name}`;
  const hint = spec.type === "boolean" ? "" : ` ${spec.hint ?? "<VALUE>"}`;
  return `${spec.short ? `-${spec.short}, ` : ""}${long}${hint}`;
}

function optionDescription(spec: OptionSpec): string {
  let text = spec.description;
  if (spec.choices && !/\(|:/u.test(text)) text += `: ${spec.choices.join(", ")}`;
  if (spec.defaultText) text += ` (default: ${spec.defaultText})`;
  return text;
}

function entries(
  theme: Theme,
  rows: readonly (readonly [string, string])[],
  width: number,
): string[] {
  const lines: string[] = [];
  const longest = Math.max(0, ...rows.map(([syntax]) => displayWidth(syntax)));
  const column = Math.min(longest, 30) + 4;
  for (const [syntax, description] of rows) {
    const styled = theme.bold(syntax);
    const room = width - column;
    if (displayWidth(syntax) + 2 > column - 2 || room < 24) {
      lines.push(`  ${styled}`);
      for (const line of wrapText(description, Math.max(20, width - 6)))
        lines.push(`      ${line}`);
      continue;
    }
    const wrapped = wrapText(description, room);
    lines.push(
      `  ${padEnd(styled, column - 2 + (styled.length - syntax.length))}${wrapped[0] ?? ""}`,
    );
    for (const line of wrapped.slice(1)) lines.push(`${" ".repeat(column)}${line}`);
  }
  return lines;
}

function sortOptions(options: readonly OptionSpec[]): OptionSpec[] {
  return [...options].filter((spec) => !spec.hidden).sort((a, b) => a.name.localeCompare(b.name));
}

export function renderHelp<Context>(
  chain: readonly CommandSpec<Context>[],
  theme: Theme,
  width = 80,
): string {
  const command = chain.at(-1)!;
  const isRoot = chain.length === 1;
  const columns = Math.max(40, Math.min(width, 100));
  const lines: string[] = [];
  lines.push(theme.bold(usageLine(chain)));
  for (const line of wrapText(command.summary, columns)) lines.push(theme.faint(line));

  const children = (command.subcommands ?? []).filter((child) => !child.hidden);
  if (children.length > 0) {
    if (isRoot) {
      const groups = new Map<string, CommandSpec<Context>[]>();
      for (const child of children) {
        const group = child.group ?? "Commands";
        groups.set(group, [...(groups.get(group) ?? []), child]);
      }
      for (const [group, members] of groups) {
        lines.push("", theme.heading(`${group}:`));
        lines.push(
          ...entries(
            theme,
            members.map((child) => [commandSyntax(child), child.summary]),
            columns,
          ),
        );
      }
    } else {
      lines.push("", theme.heading("Commands:"));
      lines.push(
        ...entries(
          theme,
          children.map((child) => [
            commandSyntax(child),
            child.name === command.defaultSubcommand ? `${child.summary} (default)` : child.summary,
          ]),
          columns,
        ),
      );
    }
  }

  const describedArguments = (command.arguments ?? []).filter(
    (argument) => argument.description !== "",
  );
  if (describedArguments.length > 0) {
    lines.push("", theme.heading("Arguments:"));
    lines.push(
      ...entries(
        theme,
        describedArguments.map((argument) => [
          argument.required ? `<${argument.name}>` : `[${argument.name}]`,
          argument.description,
        ]),
        columns,
      ),
    );
  }

  const options = sortOptions(command.options ?? []);
  if (options.length > 0) {
    lines.push("", theme.heading("Options:"));
    lines.push(
      ...entries(
        theme,
        options.map((spec) => [optionSyntax(spec), optionDescription(spec)]),
        columns,
      ),
    );
  }

  if (isRoot) {
    lines.push("", theme.heading("Global Options:"));
    lines.push(
      ...entries(
        theme,
        sortOptions(GLOBAL_OPTIONS).map((spec) => [optionSyntax(spec), optionDescription(spec)]),
        columns,
      ),
    );
  } else {
    lines.push("", `${theme.heading("Global Options:")} See \`${chain[0]!.name} --help\``);
  }

  if (command.examples && command.examples.length > 0) {
    lines.push("", theme.heading("Examples:"));
    command.examples.forEach((example, index) => {
      if (index > 0) lines.push("");
      lines.push(`  ${example.label}`);
      const text = formatCommand(example.argv);
      lines.push(`    ${text.includes("<") ? text : theme.command(text)}`);
    });
  }

  if (command.notes && command.notes.length > 0) {
    lines.push("", theme.heading("Notes:"));
    for (const note of command.notes) {
      const wrapped = wrapText(note, columns - 4);
      lines.push(`  ${wrapped[0] ?? ""}`);
      for (const line of wrapped.slice(1)) lines.push(`  ${line}`);
    }
  }

  lines.push("", `${theme.heading("Learn more:")} ${DOCS_URL}`);
  return `${lines.join("\n")}\n`;
}

function commandSyntax<Context>(command: CommandSpec<Context>): string {
  const parts = [command.name];
  for (const argument of command.arguments ?? []) {
    parts.push(argument.required ? `<${argument.name}>` : `[${argument.name}]`);
  }
  return parts.join(" ");
}

export function helpDocument<Context>(
  chain: readonly CommandSpec<Context>[],
): Record<string, unknown> {
  const command = chain.at(-1)!;
  const option = (spec: OptionSpec): Record<string, unknown> => ({
    name: `--${spec.name}`,
    ...(spec.short ? { short: `-${spec.short}` } : {}),
    type: spec.type === "list" ? "string" : spec.type,
    ...(spec.type !== "boolean" ? { valueHint: spec.hint ?? "<VALUE>" } : {}),
    ...(spec.defaultText ? { default: spec.defaultText } : {}),
    ...(spec.choices ? { choices: [...spec.choices] } : {}),
    repeatable: spec.type === "list",
    description: spec.description,
  });
  return {
    path: chain.map((item) => item.name).join(" "),
    summary: command.summary,
    usage: usageLine(chain),
    subcommands: (command.subcommands ?? [])
      .filter((child) => !child.hidden)
      .map((child) => ({
        name: child.name,
        summary: child.summary,
        ...(child.aliases && child.aliases.length > 0 ? { aliases: [...child.aliases] } : {}),
        ...(child.name === command.defaultSubcommand ? { default: true } : {}),
      })),
    arguments: (command.arguments ?? []).map((argument) => ({
      name: argument.name,
      required: argument.required === true,
      variadic: argument.variadic === true,
      description: argument.description,
    })),
    options: sortOptions(command.options ?? []).map(option),
    globalOptions: sortOptions(GLOBAL_OPTIONS).map(option),
    examples: (command.examples ?? []).map((example) => ({
      label: example.label,
      command: formatCommand(example.argv),
      argv: [...example.argv],
    })),
    ...(command.notes ? { notes: [...command.notes] } : {}),
  };
}

export function allHelpDocuments<Context>(root: CommandSpec<Context>): Record<string, unknown>[] {
  const documents: Record<string, unknown>[] = [];
  const visit = (chain: CommandSpec<Context>[]): void => {
    documents.push(helpDocument(chain));
    for (const child of chain.at(-1)!.subcommands ?? []) {
      if (!child.hidden) visit([...chain, child]);
    }
  };
  visit([root]);
  return documents;
}
