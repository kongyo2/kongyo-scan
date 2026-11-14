import type { Output } from "../cli/output.js";
import type { Terminal } from "../cli/terminal.js";
import { loadStoredKeys, type StoredKeys } from "../config/credentials.js";
import type { Config } from "../config/schema.js";
import { loadConfigFile } from "../config/store.js";
import type { AppPaths } from "../core/paths.js";

export interface AppContext {
  terminal: Terminal;
  output: Output;
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
  abortSignalName(): NodeJS.Signals | undefined;
}

export async function loadUserConfig(context: Pick<AppContext, "paths">): Promise<Config> {
  return (await loadConfigFile(context.paths.configFile)).config;
}

export async function loadKeys(context: Pick<AppContext, "paths">): Promise<StoredKeys> {
  return await loadStoredKeys(context.paths.credentialsFile);
}
