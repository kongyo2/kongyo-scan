import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { configError } from "./errors.js";

export interface AppPaths {
  home: string;
  configFile: string;
  stateDir: string;
  codexHome: string;
  credentialsFile: string;
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

export function expandHome(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (path === "~") return userHome(env);
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(userHome(env), path.slice(2));
  return resolve(path);
}

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
