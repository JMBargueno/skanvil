/**
 * Paths of the installed skanvil package.
 *
 * @module
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walks up from `start` to the skanvil package root: the first folder with both a
 * `package.json` and a `templates/` folder.
 *
 * @throws Error when no such folder exists up to the file system root.
 */
function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "templates"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot locate the skanvil package root from ${start}.`);
    }
    dir = parent;
  }
}

/**
 * Absolute root of the skanvil package. The same code resolves it from `src/` (tests, tsx) and
 * from the bundled `dist/` (installed package).
 */
export const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

/** Absolute path of the built-in templates folder. */
export const TEMPLATES_ROOT = path.join(PACKAGE_ROOT, "templates");

/** @returns The `version` field of skanvil's own package.json. */
export function packageVersion(): string {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

/**
 * Formats a path for human-readable output: relative to the current directory when it lies
 * inside it, absolute otherwise.
 *
 * @param target - Absolute path.
 * @param cwd - Base folder. @defaultValue `process.cwd()`
 * @returns The path to show the user.
 */
export function displayPath(target: string, cwd: string = process.cwd()): string {
  const relative = path.relative(cwd, target);
  if (relative === "") return ".";
  return relative.startsWith("..") || path.isAbsolute(relative) ? target : relative;
}

/**
 * @param value - Path with platform separators.
 * @returns The same path with `/` separators (for display and manifests).
 */
export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
