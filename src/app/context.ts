import type { Output } from "../cli/output.js";
import type { Terminal } from "../cli/terminal.js";
import { loadStoredKeys, type StoredKeys } from "../config/credentials.js";
import type { Config } from "../config/schema.js";
import { loadConfigFile } from "../config/store.js";
import type { AppPaths } from "../core/paths.js";

/** Everything a command needs from its surroundings. Built once per invocation. */
export interface AppContext {
  terminal: Terminal;
  output: Output;
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Aborts on SIGINT, SIGTERM, and SIGHUP. Pass it to every request and child process. */
  signal: AbortSignal;
  /** The signal that triggered the abort, when there was one. */
  abortSignalName(): NodeJS.Signals | undefined;
}

/** The user's settings file. A missing file is an empty config. */
export async function loadUserConfig(context: Pick<AppContext, "paths">): Promise<Config> {
  return (await loadConfigFile(context.paths.configFile)).config;
}

/** API keys stored outside the settings file, by lowercased provider name. */
export async function loadKeys(context: Pick<AppContext, "paths">): Promise<StoredKeys> {
  return await loadStoredKeys(context.paths.credentialsFile);
}
