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

export const PACKAGE_NAME = manifest.name;

export const VERSION = manifest.version;

export const BIN = "kongyo-scan";

let codexSecurityVersion: string | null | undefined;

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

export function userAgent(): string {
  const engine = bundledCodexSecurityVersion();
  return `${BIN}/${VERSION} (${engine ? `codex-security/${engine}; ` : ""}node/${process.versions.node}; ${process.platform}-${process.arch})`;
}
