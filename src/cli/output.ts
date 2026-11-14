import {
  CanceledError,
  CliError,
  describeError,
  type NextStep,
  sanitizeLine,
} from "../core/errors.js";
import { BIN, VERSION } from "../version.js";
import type { Terminal } from "./terminal.js";
import { createTheme, displayWidth, padEnd, type Theme, truncate, wrapText } from "./theme.js";

const LABEL_WIDTH = 16;

export function shellQuote(argument: string): string {
  if (argument === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./<>-]+$/u.test(argument)) return argument;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

export function formatCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

export interface TableColumn {
  header: string;
  shrink?: boolean;
  align?: "left" | "right";
}

export class Output {
  readonly terminal: Terminal;
  readonly out: Theme;
  readonly err: Theme;
  readonly #warnings: { reason: string; message: string }[] = [];

  constructor(terminal: Terminal) {
    this.terminal = terminal;
    this.out = createTheme(terminal.stdoutColor, terminal.stdoutRich);
    this.err = createTheme(terminal.stderrColor, terminal.stderrRich);
  }

  write(text: string): void {
    this.terminal.stdout.write(text);
  }

  line(text = ""): void {
    this.terminal.stdout.write(`${text}\n`);
  }

  info(text = ""): void {
    if (this.terminal.json) return;
    this.terminal.stderr.write(`${text}\n`);
  }

  row(label: string, value: string, glyph = " "): void {
    this.info(this.formatRow(this.err, label, value, glyph));
  }

  formatRow(theme: Theme, label: string, value: string, glyph = " "): string {
    if (!theme.rich) return `${label}: ${value}`;
    const gutter = glyph === " " ? "  " : `${glyph} `;
    if (displayWidth(label) > LABEL_WIDTH) return `${gutter}${label}  ${value}`;
    return `${gutter}${padEnd(label, LABEL_WIDTH)}${value}`;
  }

  success(headline: string, target?: string): void {
    if (this.terminal.json) return;
    const theme = this.err;
    if (!theme.rich) {
      this.info(target === undefined ? headline : `${headline} ${target}`);
      return;
    }
    const glyph = theme.success(theme.glyph.success);
    if (target === undefined) this.info(`${glyph} ${theme.bold(headline)}`);
    else this.info(`${glyph} ${theme.bold(padEnd(headline, LABEL_WIDTH))}${target}`);
  }

  warn(reason: string, message: string): void {
    this.#warnings.push({ reason, message });
    if (this.terminal.json) return;
    const theme = this.err;
    if (!theme.rich) this.info(`${theme.warning("Warning:")} ${message}`);
    else this.info(`${theme.warning(theme.glyph.warning)} ${message}`);
  }

  get warnings(): readonly { reason: string; message: string }[] {
    return this.#warnings;
  }

  next(steps: readonly NextStep[], heading?: string): void {
    if (this.terminal.json || steps.length === 0) return;
    const theme = this.err;
    this.info();
    if (heading) this.info(`  ${heading}`);
    for (const step of steps) {
      this.info(`  ${step.label}:`);
      const command = formatCommand(step.argv);
      this.info(`    ${command.includes("<") ? command : theme.command(command)}`);
    }
  }

  json(document: Record<string, unknown>, next: readonly NextStep[] = []): void {
    const body: Record<string, unknown> = { ...document };
    if (this.#warnings.length > 0) body["warnings"] = this.#warnings;
    if (next.length > 0) body["next"] = next.map(jsonStep);
    const text = this.terminal.stdout.isTTY ? JSON.stringify(body, null, 2) : JSON.stringify(body);
    this.terminal.stdout.write(`${text}\n`);
  }

  table(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): void {
    const theme = this.out;
    if (!theme.rich) {
      this.line(columns.map((column) => column.header).join("\t"));
      for (const row of rows)
        this.line(
          row.map((cell) => cell.replaceAll("\t", "\\t").replaceAll("\n", "\\n")).join("\t"),
        );
      return;
    }
    const widths = columns.map((column, index) =>
      Math.max(displayWidth(column.header), ...rows.map((row) => displayWidth(row[index] ?? ""))),
    );
    const gap = 3;
    const total = (): number =>
      2 + widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
    for (let guard = 0; total() > this.terminal.stdoutColumns && guard < 200; guard++) {
      const candidates = columns
        .map((column, index) => ({ column, index }))
        .filter(
          ({ column, index }) =>
            column.shrink && widths[index]! > Math.max(8, displayWidth(column.header)),
        );
      if (candidates.length === 0) break;
      const widest = candidates.sort((a, b) => widths[b.index]! - widths[a.index]!)[0]!;
      widths[widest.index] = widths[widest.index]! - 1;
    }
    const render = (cells: readonly string[], style: (text: string) => string): string =>
      `  ${cells
        .map((cell, index) => {
          const width = widths[index]!;
          const text = columns[index]!.shrink ? truncate(cell, width) : cell;
          if (index === cells.length - 1 && columns[index]!.align !== "right") return style(text);
          const padding = " ".repeat(Math.max(0, width - displayWidth(text)));
          return columns[index]!.align === "right" ? padding + style(text) : style(text) + padding;
        })
        .join(" ".repeat(gap))}`.trimEnd();
    this.line(
      render(
        columns.map((column) => column.header),
        theme.faint,
      ),
    );
    for (const row of rows)
      this.line(
        render(
          columns.map((_, index) => row[index] ?? ""),
          (text) => text,
        ),
      );
  }

  fail(error: unknown, commandPath: string): number {
    if (error instanceof CanceledError) {
      if (this.terminal.json) {
        this.terminal.stderr.write(
          `${JSON.stringify({ status: "error", reason: "canceled", message: `Canceled. ${error.summary}` })}\n`,
        );
      } else {
        this.terminal.stderr.write(`\nCanceled. ${error.summary}\n`);
      }
      return error.exitCode;
    }
    const cliError = error instanceof CliError ? error : internalError(error, commandPath);
    if (this.terminal.json) {
      const document: Record<string, unknown> = {
        status: cliError.status,
        reason: cliError.reason,
        message: cliError.message,
      };
      if (cliError.next.length > 0) document["next"] = cliError.next.map(jsonStep);
      const data: Record<string, unknown> = { ...cliError.data };
      if (cliError.issues.length > 0) data["issues"] = cliError.issues;
      if (Object.keys(data).length > 0) document["data"] = data;
      if (cliError.retryable !== undefined) document["retryable"] = cliError.retryable;
      if (this.#warnings.length > 0) document["warnings"] = this.#warnings;
      this.terminal.stderr.write(`${JSON.stringify(document)}\n`);
      return cliError.exitCode;
    }
    this.terminal.stderr.write(`${this.formatError(cliError)}\n`);
    if (this.terminal.debug && cliError.cause !== undefined) {
      const cause =
        cliError.cause instanceof Error
          ? (cliError.cause.stack ?? cliError.cause.message)
          : String(cliError.cause);
      this.terminal.stderr.write(`\n${cause}\n`);
    }
    return cliError.exitCode;
  }

  formatError(error: CliError): string {
    const theme = this.err;
    const lines: string[] = [""];
    const width = Math.max(40, this.terminal.stderrColumns);
    const headline = theme.rich
      ? `${theme.danger(theme.glyph.error)} ${error.message}`
      : `${theme.danger("Error:")} ${error.message}`;
    lines.push(...wrapText(headline, width));
    const details = error.details.slice(0, error.reason === "invalid_config" ? 12 : 5);
    for (const detail of details) lines.push(`  ${detail}`);
    if (error.details.length > details.length)
      lines.push(`  and ${error.details.length - details.length} more`);
    for (const [label, value] of error.rows) lines.push(this.formatRow(theme, label, value));
    if (error.hint !== undefined && error.next.length === 0) {
      lines.push("");
      lines.push(...wrapText(error.hint, width - 2).map((line) => `  ${line}`));
    }
    const steps = error.next.slice(0, 2);
    if (steps.length > 0) {
      lines.push("");
      if (error.hint !== undefined)
        lines.push(...wrapText(error.hint, width - 2).map((line) => `  ${line}`));
      steps.forEach((step, index) => {
        lines.push(`  ${index === 0 ? step.label : `Or ${lowerFirst(step.label)}`}:`);
        const command = formatCommand(step.argv);
        lines.push(`    ${command.includes("<") ? command : theme.command(command)}`);
      });
    }
    return lines.join("\n");
  }
}

function jsonStep(step: NextStep): Record<string, unknown> {
  return {
    command: formatCommand(step.argv),
    argv: [...step.argv],
    ...(step.when === undefined ? {} : { when: step.when }),
  };
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function internalError(error: unknown, commandPath: string): CliError {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return new CliError("internal", `Unexpected error in ${commandPath}. This is a bug in ${BIN}.`, {
    reason: "internal_error",
    rows: [
      ["Error", sanitizeLine(`${name}: ${describeError(error)}`).slice(0, 200)],
      [
        "Version",
        `${BIN} ${VERSION}, Node.js ${process.versions.node}, ${process.platform}-${process.arch}`,
      ],
    ],
    hint: "Run again with --debug for the stack trace, then report it at https://github.com/kongyo2/kongyo-scan/issues",
    cause: error,
  });
}
