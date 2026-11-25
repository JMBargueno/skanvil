/**
 * Machine-readable CI formatters for validation results: GitHub Actions annotations and SARIF 2.1.0.
 *
 * @module
 */
import path from "node:path";

import { packageVersion } from "../util/paths.js";
import { CONFIG_FILE } from "./config.js";
import type { Library } from "./library.js";
import { formatDiagnostic, RULES, type Diagnostic, type ValidationResult } from "./validate.js";

/** Supported output formats for `skanvil validate --format`. */
export type ValidateOutputFormat = "text" | "github" | "sarif" | "json";

/**
 * Resolves the library-relative posix path associated with a validation {@link Diagnostic}.
 *
 * @param diagnostic - Validation diagnostic.
 * @param library - Owning library.
 * @returns Relative posix path from `library.root` (for example `skills/front-api/SKILL.md` or `README.md`).
 */
export function resolveDiagnosticFile(diagnostic: Diagnostic, library: Library): string {
  if (diagnostic.file) return diagnostic.file;
  const readmeRef = library.config.readme.split(path.sep).join("/");
  if (diagnostic.rule.startsWith("readme-")) return readmeRef;
  if (diagnostic.skill) {
    if (diagnostic.rule === "params-file") return `${library.skillsDirRef}/${diagnostic.skill}/params.json`;
    if (
      diagnostic.rule === "evals-file" ||
      diagnostic.rule === "evals-required" ||
      diagnostic.rule === "duplicate-trigger"
    ) {
      return `${library.skillsDirRef}/${diagnostic.skill}/evals.json`;
    }
    return `${library.skillsDirRef}/${diagnostic.skill}/SKILL.md`;
  }
  return diagnostic.rule === "always-loaded-budget" ? CONFIG_FILE : readmeRef;
}

function escapeGitHubProperty(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function escapeGitHubData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Formats validation findings as GitHub Actions workflow commands (`::error` / `::warning`) so
 * Pull Request file diffs render inline annotations automatically.
 *
 * @param result - Result returned by {@link validateLibrary}.
 * @param library - Validated library used to resolve relative file locations.
 * @returns Newline-terminated workflow commands, or an empty string when there are no diagnostics.
 *
 * @example
 * ```ts
 * const result = await validateLibrary(lib);
 * process.stdout.write(formatGitHubAnnotations(result, lib));
 * ```
 */
export function formatGitHubAnnotations(result: ValidationResult, library: Library): string {
  if (result.diagnostics.length === 0) return "";
  const lines = result.diagnostics.map((diagnostic) => {
    const level = diagnostic.severity === "error" ? "error" : "warning";
    const file = escapeGitHubProperty(resolveDiagnosticFile(diagnostic, library));
    const line = diagnostic.line ?? 1;
    const title = escapeGitHubProperty(diagnostic.rule);
    const message = escapeGitHubData(formatDiagnostic(diagnostic));
    return `::${level} file=${file},line=${line},title=${title}::${message}`;
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Formats validation findings as a SARIF 2.1.0 JSON report suitable for GitHub Code Scanning
 * and CI security/quality dashboards.
 *
 * @param result - Result returned by {@link validateLibrary}.
 * @param library - Validated library used to resolve artifact URIs.
 * @returns Pretty-printed SARIF 2.1.0 JSON payload with a trailing newline.
 *
 * @example
 * ```ts
 * const sarif = formatSarif(await validateLibrary(lib), lib);
 * await fs.writeFile("skanvil.sarif", sarif, "utf8");
 * ```
 */
export function formatSarif(result: ValidationResult, library: Library): string {
  const seenRuleIds = new Set<string>();
  const rules: {
    id: string;
    shortDescription: { text: string };
    defaultConfiguration: { level: "error" | "warning" };
  }[] = [];

  for (const diagnostic of result.diagnostics) {
    if (seenRuleIds.has(diagnostic.rule)) continue;
    seenRuleIds.add(diagnostic.rule);
    const def = RULES[diagnostic.rule];
    rules.push({
      id: diagnostic.rule,
      shortDescription: { text: def?.description ?? diagnostic.rule },
      defaultConfiguration: { level: (def?.severity ?? diagnostic.severity) === "warn" ? "warning" : "error" }
    });
  }

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "skanvil",
            version: packageVersion(),
            informationUri: "https://github.com/jmbargueno/skanvil",
            rules
          }
        },
        results: result.diagnostics.map((diagnostic) => ({
          ruleId: diagnostic.rule,
          level: diagnostic.severity === "error" ? "error" : "warning",
          message: { text: formatDiagnostic(diagnostic) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: resolveDiagnosticFile(diagnostic, library) },
                region: { startLine: diagnostic.line ?? 1 }
              }
            }
          ]
        }))
      }
    ]
  };

  return `${JSON.stringify(sarif, null, 2)}\n`;
}
