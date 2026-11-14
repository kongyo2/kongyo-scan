import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { configError, isNodeError } from "../core/errors.js";

/**
 * API keys stored by kongyo-scan. They live apart from the settings file, in the
 * one directory the scan sandbox refuses to read, so an agent that strays outside
 * the repository can never see them or send them to a model.
 */
export interface Credentials {
  version: 1;
  /** Keyed by lowercased provider name. */
  providers: Record<string, { api_key: string }>;
}

/** Stored keys by lowercased provider name. */
export type StoredKeys = Readonly<Record<string, string>>;

export function emptyCredentials(): Credentials {
  return { version: 1, providers: {} };
}

function keyOf(provider: string): string {
  return provider.toLowerCase();
}

export async function loadCredentials(file: string): Promise<Credentials> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyCredentials();
    throw configError(`Can't read ${file}. ${isNodeError(error) ? error.message : String(error)}`, {
      cause: error,
    });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const credentials = emptyCredentials();
    const providers =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { providers?: unknown }).providers
        : undefined;
    if (providers !== null && typeof providers === "object") {
      for (const [name, entry] of Object.entries(providers as Record<string, unknown>)) {
        const key =
          entry !== null && typeof entry === "object"
            ? (entry as { api_key?: unknown }).api_key
            : undefined;
        if (typeof key === "string" && key !== "")
          credentials.providers[keyOf(name)] = { api_key: key };
      }
    }
    return credentials;
  } catch (error) {
    // Never echo the file: it holds only secrets.
    throw configError(`${file} isn't valid JSON.`, {
      hint: "Remove the file and store the keys again with providers update --api-key-stdin.",
      cause: error,
    });
  }
}

export function storedKeys(credentials: Credentials): StoredKeys {
  return Object.fromEntries(
    Object.entries(credentials.providers).map(([name, entry]) => [name, entry.api_key]),
  );
}

export async function loadStoredKeys(file: string): Promise<StoredKeys> {
  return storedKeys(await loadCredentials(file));
}

async function saveCredentials(file: string, credentials: Credentials): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.credentials.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    created = false;
    if (process.platform !== "win32") await chmod(file, 0o600);
  } catch (error) {
    throw configError(
      `Can't write ${file}. ${isNodeError(error) ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

/** Re-read, change, and write back the credentials file. */
async function updateCredentials(
  file: string,
  change: (credentials: Credentials) => boolean,
): Promise<void> {
  const credentials = await loadCredentials(file);
  if (change(credentials)) await saveCredentials(file, credentials);
}

export async function setProviderKey(
  file: string,
  provider: string,
  apiKey: string,
): Promise<void> {
  await updateCredentials(file, (credentials) => {
    credentials.providers[keyOf(provider)] = { api_key: apiKey };
    return true;
  });
}

export async function deleteProviderKey(file: string, provider: string): Promise<boolean> {
  let removed = false;
  await updateCredentials(file, (credentials) => {
    if (credentials.providers[keyOf(provider)] === undefined) return false;
    delete credentials.providers[keyOf(provider)];
    removed = true;
    return true;
  });
  return removed;
}

export async function renameProviderKey(file: string, from: string, to: string): Promise<void> {
  if (keyOf(from) === keyOf(to)) return;
  await updateCredentials(file, (credentials) => {
    const entry = credentials.providers[keyOf(from)];
    if (entry === undefined) return false;
    credentials.providers[keyOf(to)] = entry;
    delete credentials.providers[keyOf(from)];
    return true;
  });
}
