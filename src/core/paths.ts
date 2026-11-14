import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { configError } from "./errors.js";

/** Every location kongyo-scan owns. Nothing is written outside `home` unless asked. */
export interface AppPaths {
  /** Root directory: `KONGYO_SCAN_HOME`, or `~/.kongyo-scan`. */
  home: string;
  /** Providers, defaults, and other preferences. Created owner-only. */
  configFile: string;
  /** Codex Security history, database, and default scan artifacts. */
  stateDir: string;
  /** Private Codex home used by scans; never the person's own `~/.codex`. */
  codexHome: string;
  /**
   * Stored API keys. The file sits in the one directory the scan sandbox denies,
   * so a scan can never read the keys even though it may read the rest of the disk.
   */
  credentialsFile: string;
  /** One line per scan started by kongyo-scan. */
  historyFile: string;
}

export const HOME_ENV = "KONGYO_SCAN_HOME";

export function resolvePaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  override?: string,
): AppPaths {
  const configured = override ?? env[HOME_ENV];
  let home: string;
  if (configured !== undefined && configured.trim() !== "") {
    if (!isAbsolute(configured) && !configured.startsWith("~")) {
      home = resolve(configured);
    } else {
      home = expandHome(configured, env);
    }
  } else {
    home = join(userHome(env), ".kongyo-scan");
  }
  return {
    home,
    configFile: join(home, "config.json"),
    stateDir: join(home, "state"),
    codexHome: join(home, "codex-home"),
    credentialsFile: join(home, "state", "codex-home", "kongyo-scan-credentials.json"),
    historyFile: join(home, "history.jsonl"),
  };
}

function userHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? homedir();
  if (!home) {
    throw configError(`Can't locate a home directory. Set ${HOME_ENV} to an absolute path.`);
  }
  return home;
}

/** Expand a leading `~` and make the path absolute. */
export function expandHome(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (path === "~") return userHome(env);
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(userHome(env), path.slice(2));
  return resolve(path);
}

/** Show a path with the home directory abbreviated, for human output only. */
export function displayPath(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = env["HOME"] ?? env["USERPROFILE"];
  if (home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}
