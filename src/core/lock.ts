import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { configError, isNodeError } from "./errors.js";

const STALE_AFTER_MS = 30_000;
const WAIT_LIMIT_MS = 10_000;

/** Takes the lock, or waits a moment for its holder and reports that it is still held. */
async function acquire(lock: string): Promise<boolean> {
  try {
    await (await open(lock, "wx", 0o600)).close();
    return true;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const heldSince = await stat(lock).then(
    (stats) => stats.mtimeMs,
    () => undefined,
  );
  // A lock older than any real update belongs to a process that died; take it over.
  if (heldSince !== undefined && Date.now() - heldSince > STALE_AFTER_MS) {
    await rm(lock, { force: true });
  } else {
    await delay(20 + Math.random() * 40);
  }
  return false;
}

/**
 * Runs a read-modify-write of `file` while holding `<file>.lock`, so two kongyo-scan processes,
 * or two tasks in one, cannot overwrite each other's change.
 */
export async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + WAIT_LIMIT_MS;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    // oxlint-disable-next-line no-await-in-loop -- each attempt waits for the current holder; they cannot overlap.
    while (!(await acquire(lock))) {
      if (Date.now() > deadline) {
        throw configError(`Can't change ${file}. Another kongyo-scan process is changing it.`, {
          hint: `Run the command again. If no other kongyo-scan is running, remove ${lock}.`,
        });
      }
    }
  } catch (error) {
    if (!isNodeError(error)) throw error;
    throw configError(`Can't change ${file}. ${error.message}`, { cause: error });
  }
  try {
    return await task();
  } finally {
    await rm(lock, { force: true });
  }
}
