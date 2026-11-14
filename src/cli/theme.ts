/** Semantic styling. Callers name a role; only this module knows ANSI codes and glyphs. */

export interface Theme {
  color: boolean;
  rich: boolean;
  bold(text: string): string;
  faint(text: string): string;
  underline(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  danger(text: string): string;
  /** A complete command the person can run. */
  command(text: string): string;
  /** Help section headings. */
  heading(text: string): string;
  glyph: {
    success: string;
    warning: string;
    error: string;
    pointer: string;
    bullet: string;
    ellipsis: string;
  };
}

const ESC = "\u001B[";

function wrap(enabled: boolean, open: string, close: string): (text: string) => string {
  if (!enabled) return (text) => text;
  return (text) => (text === "" ? text : `${ESC}${open}m${text}${ESC}${close}m`);
}

export function createTheme(color: boolean, rich: boolean): Theme {
  const bold = wrap(color, "1", "22");
  const magenta = wrap(color, "35", "39");
  return {
    color,
    rich,
    bold,
    faint: wrap(color, "2", "22"),
    underline: wrap(color, "4", "24"),
    success: wrap(color, "32", "39"),
    warning: wrap(color, "33", "39"),
    danger: wrap(color, "31", "39"),
    command: wrap(color, "36", "39"),
    heading: (text) => bold(magenta(text)),
    glyph: rich
      ? { success: "✓", warning: "!", error: "✗", pointer: "›", bullet: "•", ellipsis: "…" }
      : {
          success: "",
          warning: "Warning:",
          error: "Error:",
          pointer: ">",
          bullet: "-",
          ellipsis: "...",
        },
  };
}

const ESCAPE = String.fromCodePoint(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");

export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI_PATTERN, "");
}

/** Terminal cell width of a string: wide East Asian characters count as two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of stripAnsi(text)) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function padEnd(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** Shorten optional descriptive text to fit; never use this for IDs, paths, or commands. */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  let result = "";
  let used = 0;
  const budget = width - displayWidth(ellipsis);
  for (const character of text) {
    const next = displayWidth(character);
    if (used + next > budget) break;
    result += character;
    used += next;
  }
  return result + ellipsis;
}

/** Wrap prose to a width, keeping words intact. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      if (line === "") line = word;
      else if (displayWidth(line) + 1 + displayWidth(word) <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}
