/**
 * File system helpers.
 *
 * @module
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * @param target - Path to check.
 * @returns Whether the path exists and is accessible.
 */
export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param dir - Folder to check.
 * @returns `true` when the folder does not exist or has no entries.
 */
export async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await fs.readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/**
 * Lists the files of a folder tree. Symlinks and other special entries are skipped.
 *
 * @param dir - Root folder.
 * @param relative - Internal recursion state; leave empty.
 * @returns Paths relative to `dir` with posix separators, sorted.
 */
export async function listFiles(dir: string, relative = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(dir, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFiles(dir, rel)));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Computes a stable hash of a folder tree. It is used by sync to detect changed skills.
 *
 * @param dir - Root folder.
 * @returns The first 16 hex characters of a SHA-256 over every relative path and file content.
 */
export async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
