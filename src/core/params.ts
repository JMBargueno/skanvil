/**
 * Skill parameters: the optional `params.json` next to a `SKILL.md`, and the tiny template
 * language used in the skill (`{{name}}`, `{{#if …}}…{{else}}…{{/if}}`).
 *
 * {@link renderTemplate} and {@link resolveParamValues} are self-contained (no imports, no outer
 * references) because `skanvil build` embeds their source in the generated package, so libraries
 * render exactly like skanvil without depending on it at runtime.
 *
 * @module
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** File that declares a skill's parameters, next to its `SKILL.md`. Not part of the Agent Skills spec. */
export const PARAMS_FILE = "params.json";

const ParamSchema = z.union([
  z
    .object({
      type: z.literal("enum"),
      values: z.array(z.string()).min(1),
      default: z.string(),
      description: z.string().optional()
    })
    .strict(),
  z.object({ type: z.literal("string"), default: z.string(), description: z.string().optional() }).strict(),
  z.object({ type: z.literal("boolean"), default: z.boolean(), description: z.string().optional() }).strict()
]);

/** Zod schema of `params.json`: parameter names (camelCase) mapped to their definitions. */
export const ParamsFileSchema = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "parameter names must be camelCase letters and digits"),
  ParamSchema
);

/** One parameter definition. Every parameter has a default, so skills always render. */
export type ParamDefinition = z.infer<typeof ParamSchema>;

/** Parameter definitions of a skill, by name. */
export type ParamDefinitions = Record<string, ParamDefinition>;

/** Parameter values, as passed by users (`--param key=value` gives strings). */
export type ParamValues = Record<string, string | boolean>;

/**
 * Parses and checks the content of a `params.json`.
 *
 * @param text - File content.
 * @returns The definitions.
 * @throws Error describing the first problems: invalid JSON, unknown fields, missing defaults,
 *   or an enum default that is not one of its values.
 */
export function parseParams(text: string): ParamDefinitions {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${PARAMS_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const invalid = Object.keys(json).filter((key) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key));
    if (invalid.length > 0) {
      throw new Error(
        `invalid ${PARAMS_FILE}: parameter names must be camelCase letters and digits (${invalid.join(", ")})`
      );
    }
  }
  const parsed = ParamsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`invalid ${PARAMS_FILE}: ${issues.slice(0, 3).join("; ")}`);
  }
  for (const [name, definition] of Object.entries(parsed.data)) {
    if (definition.type === "enum" && !definition.values.includes(definition.default)) {
      throw new Error(`invalid ${PARAMS_FILE}: ${name}.default must be one of ${definition.values.join(", ")}`);
    }
  }
  return parsed.data;
}

/**
 * Reads a skill folder's `params.json`.
 *
 * @param skillDir - Absolute skill folder.
 * @returns The definitions, or `null` when the skill has no `params.json`.
 * @throws Error when the file exists but is invalid (see {@link parseParams}).
 */
export async function readParams(skillDir: string): Promise<ParamDefinitions | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(skillDir, PARAMS_FILE), "utf8");
  } catch {
    return null;
  }
  return parseParams(text);
}

/**
 * Checks values against definitions and fills in defaults.
 *
 * Strings `"true"` / `"false"` are accepted for boolean parameters, so CLI values work.
 *
 * @param definitions - The skill's parameters.
 * @param given - Values to apply. @defaultValue `{}`
 * @param skill - Skill name used in error messages.
 * @param ignoreUnknown - Ignore values for parameters this skill does not declare (used when one
 *   set of values is applied to many skills). @defaultValue `false`
 * @returns A value for every declared parameter.
 * @throws Error for an unknown parameter (unless ignored), an enum value outside its list, or a
 *   value of the wrong type.
 *
 * @remarks Self-contained on purpose: `skanvil build` embeds this function's source.
 */
export function resolveParamValues(
  definitions: ParamDefinitions,
  given: Record<string, unknown> = {},
  skill = "skill",
  ignoreUnknown = false
): ParamValues {
  const values: ParamValues = {};
  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(definitions, key) && !ignoreUnknown) {
      const known = Object.keys(definitions);
      throw new Error(
        `${skill} has no parameter '${key}'` +
          (known.length ? ` (parameters: ${known.join(", ")})` : " (it has no parameters)")
      );
    }
  }
  for (const [name, definition] of Object.entries(definitions)) {
    const raw =
      Object.prototype.hasOwnProperty.call(given, name) && given[name] !== undefined ? given[name] : definition.default;
    if (definition.type === "boolean") {
      if (raw === true || raw === "true") values[name] = true;
      else if (raw === false || raw === "false") values[name] = false;
      else throw new Error(`${skill}: parameter '${name}' must be true or false, got ${JSON.stringify(raw)}`);
    } else if (typeof raw !== "string") {
      throw new Error(`${skill}: parameter '${name}' must be a string, got ${JSON.stringify(raw)}`);
    } else if (definition.type === "enum" && !definition.values.includes(raw)) {
      throw new Error(`${skill}: parameter '${name}' must be one of ${definition.values.join(", ")}, got "${raw}"`);
    } else {
      values[name] = raw;
    }
  }
  return values;
}

/**
 * Renders a skill template.
 *
 * Syntax:
 * - `{{name}}` is replaced by the value of a declared parameter. Names that are not parameters are
 *   left untouched, so literal `{{…}}` text in a skill without parameters is safe.
 * - `{{#if name}}`, `{{#if !name}}`, `{{#if name == "value"}}` and `{{#if name != "value"}}`
 *   (single or double quotes) start a block, with an optional `{{else}}`, closed by `{{/if}}`.
 *   Blocks nest. A tag alone on its line removes the whole line, so blocks leave no blank lines.
 *
 * @param text - Template (LF or CRLF).
 * @param values - Values for every parameter, normally from {@link resolveParamValues}.
 * @returns The rendered text.
 * @throws Error for an `{{#if}}` on an unknown parameter, a malformed condition, or unbalanced
 *   `{{#if}}` / `{{else}}` / `{{/if}}` tags.
 *
 * @example
 * ```ts
 * renderTemplate('Use {{tracker}}.\n{{#if tracker == "jira"}}\nAdd the key.\n{{/if}}\n', { tracker: "jira" });
 * // "Use jira.\nAdd the key.\n"
 * ```
 *
 * @remarks Self-contained on purpose: `skanvil build` embeds this function's source.
 */
export function renderTemplate(text: string, values: Record<string, string | boolean>): string {
  const tagPattern = /\{\{\s*(#if\s+[^}]*?|else|\/if|[A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
  type Token =
    | { kind: "text"; value: string }
    | { kind: "if"; expr: string }
    | { kind: "else" }
    | { kind: "end" }
    | { kind: "var"; name: string; raw: string };
  const tokens: Token[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(text)) !== null) {
    const body = match[1];
    const isBlock = body.startsWith("#if") || body === "else" || body === "/if";
    let start = match.index;
    let end = match.index + match[0].length;
    if (isBlock) {
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const newline = text.indexOf("\n", end);
      const lineEnd = newline === -1 ? text.length : newline;
      const before = text.slice(lineStart, start);
      const after = text.slice(end, lineEnd);
      if (before.trim() === "" && after.trim() === "" && lineStart >= cursor) {
        start = lineStart;
        end = newline === -1 ? text.length : newline + 1;
      }
    }
    if (start > cursor) tokens.push({ kind: "text", value: text.slice(cursor, start) });
    if (body.startsWith("#if")) tokens.push({ kind: "if", expr: body.slice(3).trim() });
    else if (body === "else") tokens.push({ kind: "else" });
    else if (body === "/if") tokens.push({ kind: "end" });
    else tokens.push({ kind: "var", name: body, raw: match[0] });
    cursor = end;
    tagPattern.lastIndex = end;
  }
  if (cursor < text.length) tokens.push({ kind: "text", value: text.slice(cursor) });

  const has = (name: string) => Object.prototype.hasOwnProperty.call(values, name);
  const evaluate = (expr: string): boolean => {
    const comparison = expr.match(/^([A-Za-z][A-Za-z0-9]*)\s*(==|!=)\s*(?:"([^"]*)"|'([^']*)')$/);
    if (comparison) {
      const [, name, operator, double, single] = comparison;
      if (!has(name)) throw new Error(`{{#if ${expr}}} uses unknown parameter '${name}'`);
      const equal = String(values[name]) === (double !== undefined ? double : single);
      return operator === "==" ? equal : !equal;
    }
    const truthy = expr.match(/^(!?)([A-Za-z][A-Za-z0-9]*)$/);
    if (truthy) {
      const [, negate, name] = truthy;
      if (!has(name)) throw new Error(`{{#if ${expr}}} uses unknown parameter '${name}'`);
      const value = values[name];
      const result = value !== false && value !== "" && value !== "false";
      return negate ? !result : result;
    }
    throw new Error(`invalid condition {{#if ${expr}}}: use name, !name, name == "value" or name != "value"`);
  };

  const stack: { active: boolean; parentActive: boolean; sawElse: boolean }[] = [];
  let output = "";
  let active = true;
  for (const token of tokens) {
    if (token.kind === "if") {
      const condition: boolean = active ? evaluate(token.expr) : false;
      stack.push({ active: condition, parentActive: active, sawElse: false });
      active = active && condition;
    } else if (token.kind === "else") {
      const frame = stack[stack.length - 1];
      if (!frame || frame.sawElse) throw new Error("{{else}} without a matching {{#if}}");
      frame.sawElse = true;
      active = frame.parentActive && !frame.active;
    } else if (token.kind === "end") {
      const frame = stack.pop();
      if (!frame) throw new Error("{{/if}} without a matching {{#if}}");
      active = frame.parentActive;
    } else if (active) {
      output += token.kind === "text" ? token.value : has(token.name) ? String(values[token.name]) : token.raw;
    }
  }
  if (stack.length > 0) throw new Error(`${stack.length} {{#if}} block(s) are not closed with {{/if}}`);
  return output;
}

/**
 * Lists the `{{name}}` placeholders of a template that are not declared parameters.
 *
 * @param text - Template.
 * @param definitions - Declared parameters.
 * @returns Unique undeclared names, in order of appearance.
 */
export function findUndeclaredParams(text: string, definitions: ParamDefinitions): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g)) {
    if (match[1] !== "else" && !Object.prototype.hasOwnProperty.call(definitions, match[1])) names.add(match[1]);
  }
  return [...names];
}

/**
 * Parses `key=value` pairs (from repeated `--param` options).
 *
 * @param pairs - Entries such as `ticketTracker=jira`; values may contain `=`.
 * @returns The values (strings; booleans are converted by {@link resolveParamValues}).
 * @throws Error for an entry without `=` or with an invalid name.
 */
export function parseParamPairs(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    const key = index === -1 ? "" : pair.slice(0, index).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) {
      throw new Error(`Invalid --param '${pair}'. Use name=value, e.g. --param ticketTracker=jira`);
    }
    values[key] = pair.slice(index + 1);
  }
  return values;
}
