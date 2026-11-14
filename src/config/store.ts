import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CliError, configError, isNodeError, type Issue } from "../core/errors.js";
import { withFileLock } from "../core/lock.js";
import { type Config, ConfigSchema, emptyConfig, formatIssues } from "./schema.js";

export interface LoadedConfig {
  config: Config;
  path: string;
  exists: boolean;
}

export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { config: emptyConfig(), path, exists: false };
    }
    throw configError(`Can't read ${path}. ${isNodeError(error) ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return { config: parseConfigText(text, path), path, exists: true };
}

export function parseConfigText(text: string, path: string): Config {
  const source = text.replace(/^\uFEFF/u, "");
  let raw: unknown;
  try {
    raw = source.trim() === "" ? {} : JSON.parse(source);
  } catch (error) {
    throw jsonSyntaxError(source, path, error);
  }
  return validateConfig(raw, path);
}

export function validateConfig(raw: unknown, path: string): Config {
  const result = ConfigSchema.safeParse(raw);
  if (result.success) {
    const duplicates = duplicateProviderNames(result.data);
    if (duplicates.length > 0) {
      throw configError(`${path}: providers must have unique names.`, {
        details: duplicates.map((name) => `providers: "${name}" is defined more than once.`),
        issues: duplicates.map((name) => ({
          field: "providers",
          reason: "duplicate",
          message: `"${name}" is defined more than once.`,
        })),
      });
    }
    return result.data;
  }
  const problems = formatIssues(result.error);
  const issues: Issue[] = problems.map((problem) => ({
    field: problem.path,
    reason: "invalid",
    message: `${problem.path} ${problem.message}.`,
  }));
  const count = issues.length;
  throw configError(`${path}: ${count} ${count === 1 ? "setting is" : "settings are"} invalid.`, {
    details: issues.map((issue) => issue.message),
    issues,
  });
}

function duplicateProviderNames(config: Config): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const provider of config.providers ?? []) {
    const key = provider.name.toLowerCase();
    if (seen.has(key)) duplicates.add(provider.name);
    seen.add(key);
  }
  return [...duplicates];
}

function jsonSyntaxError(source: string, path: string, error: unknown): CliError {
  const message = error instanceof Error ? error.message : String(error);
  const offset = /position (\d+)/u.exec(message)?.[1];
  let line = 1;
  let column = 1;
  if (offset !== undefined) {
    const before = source.slice(0, Number(offset));
    line = before.split("\n").length;
    column = before.length - before.lastIndexOf("\n");
  } else {
    const match = /line (\d+) column (\d+)/u.exec(message);
    if (match) {
      line = Number(match[1]);
      column = Number(match[2]);
    }
  }
  const lines = source.split("\n");
  const width = String(Math.min(lines.length, line + 1)).length;
  const frame: string[] = [];
  for (let index = Math.max(1, line - 2); index <= Math.min(lines.length, line); index++) {
    frame.push(`${String(index).padStart(width)} │ ${maskValues(lines[index - 1] ?? "")}`);
  }
  frame.push(`${" ".repeat(width)} │ ${" ".repeat(Math.max(0, column - 1))}^`);
  return configError(`${path}:${line}:${column} isn't valid JSON.`, {
    details: frame,
    cause: error,
  });
}

function maskValues(line: string): string {
  return line.replaceAll(/(:\s*)"(?:[^"\\]|\\.)*"/gu, '$1"…"');
}

function serializeConfig(config: Config): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function saveConfigFile(path: string, config: Config): Promise<void> {
  const validated = validateConfig(config, path);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = await resolveWriteTarget(path);
  const temporary = join(dirname(target), `.${randomBytes(8).toString("hex")}.config.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(serializeConfig(validated), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    created = false;
    if (process.platform !== "win32") await chmod(target, 0o600);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw configError(
      `Can't write ${path}. ${isNodeError(error) ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function resolveWriteTarget(path: string): Promise<string> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return await realpath(path);
    if (!stats.isFile()) {
      throw configError(`Can't write ${path}. It isn't a regular file.`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  return path;
}

/**
 * Applies one change to the settings file. The file is locked and read again first, so a change
 * made by another process in the meantime is kept. Nothing is written when nothing changed.
 */
export async function updateConfigFile(
  path: string,
  change: (config: Config) => Config | void,
): Promise<Config> {
  return await withFileLock(path, async () => {
    const { config } = await loadConfigFile(path);
    const draft = structuredClone(config);
    const next = change(draft) ?? draft;
    if (serializeConfig(next) !== serializeConfig(config)) await saveConfigFile(path, next);
    return next;
  });
}
