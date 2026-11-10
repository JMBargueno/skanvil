/**
 * Helpers shared by the CLI command handlers.
 *
 * @module
 */
import path from "node:path";

import { Library } from "../core/library.js";
import { formatDiagnostic, validateLibrary, type ValidationResult } from "../core/validate.js";
import { Output } from "../util/output.js";

/** Options accepted by every command. */
export interface CommonOptions {
  /** Library root (`-C, --cwd`). @defaultValue `process.cwd()` */
  cwd?: string;
  /** Machine-readable JSON output (`--json`). */
  json?: boolean;
}

/**
 * @param options - Command options.
 * @returns Absolute library root from `--cwd`, or the current directory.
 */
export function resolveRoot(options: CommonOptions): string {
  return path.resolve(options.cwd || process.cwd());
}

/**
 * Opens the library selected by `--cwd`.
 *
 * @param options - Command options.
 * @returns The library.
 * @throws Error when the folder is not a skanvil library.
 */
export function openLibrary(options: CommonOptions): Promise<Library> {
  return Library.open(resolveRoot(options));
}

/** @returns Whether both stdin and stdout are terminals, so prompts can be shown. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prints every diagnostic: errors in red, warnings in yellow, followed by a summary line.
 *
 * @param out - Logger of the running command.
 * @param result - Validation result.
 * @param strict - Count warnings as blocking. @defaultValue `false`
 * @returns The number of blocking problems: errors, plus warnings when `strict` is set.
 */
export function printValidation(out: Output, result: ValidationResult, strict = false): number {
  for (const diagnostic of result.diagnostics) {
    const line = `${formatDiagnostic(diagnostic)} [${diagnostic.rule}]`;
    if (diagnostic.severity === "error") out.error(` - ${line}`);
    else out.warn(` - ${line}`);
  }
  const blocking = result.errors + (strict ? result.warnings : 0);
  if (blocking === 0) {
    const suffix = result.warnings > 0 ? ` (${result.warnings} warning${result.warnings === 1 ? "" : "s"})` : "";
    out.success(`OK. ${result.count} skills validated${suffix}.`);
  } else {
    out.error(`${result.errors} error(s), ${result.warnings} warning(s).`);
  }
  return blocking;
}

/**
 * Validates the library after a mutating command (`add`, `edit`) and prints the result.
 *
 * @param library - Library that was changed.
 * @param label - Command name used as output prefix.
 * @param skip - `--skip-validate` was given.
 * @returns Exit code: 1 when validation found errors, otherwise 0.
 */
export async function validateAfter(library: Library, label: string, skip: boolean | undefined): Promise<number> {
  if (skip) return 0;
  return printValidation(new Output(label), await validateLibrary(library)) > 0 ? 1 : 0;
}
