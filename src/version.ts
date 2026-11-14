import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface PackageManifest {
  name: string;
  version: string;
}

function readManifest(url: URL): PackageManifest {
  return JSON.parse(readFileSync(url, "utf8")) as PackageManifest;
}

const manifest = readManifest(new URL("../package.json", import.meta.url));

/** The published package name, used for update hints and user agents. */
export const PACKAGE_NAME = manifest.name;

/** The kongyo-scan version from package.json. */
export const VERSION = manifest.version;

/** The command name people type. */
export const BIN = "kongyo-scan";

let codexSecurityVersion: string | null | undefined;

/** Version of the bundled @openai/codex-security dependency, or null when it cannot be resolved. */
export function bundledCodexSecurityVersion(): string | null {
  if (codexSecurityVersion !== undefined) return codexSecurityVersion;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@openai/codex-security");
    codexSecurityVersion = readManifest(new URL("../package.json", pathToFileURL(entry))).version;
  } catch {
    codexSecurityVersion = null;
  }
  return codexSecurityVersion;
}

/** User agent sent to model endpoints; names this client rather than an HTTP library. */
export function userAgent(): string {
  const engine = bundledCodexSecurityVersion();
  return `${BIN}/${VERSION} (${engine ? `codex-security/${engine}; ` : ""}node/${process.versions.node}; ${process.platform}-${process.arch})`;
}
