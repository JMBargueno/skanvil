/**
 * String helpers for skill names, titles and descriptions.
 *
 * @module
 */

/**
 * Strict kebab-case: lowercase letters and digits in groups joined by single hyphens.
 * This is the Agent Skills spec's `name` alphabet (the spec also caps the length at 64).
 */
export const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Escapes every regular-expression metacharacter so the value matches literally.
 *
 * @param value - Text to embed in a `RegExp`.
 * @returns The escaped text.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converts any value to strict kebab-case: strips diacritics, lower-cases, and joins runs of
 * non-alphanumeric characters with single hyphens.
 *
 * @param value - Value to convert (`null`/`undefined` become `""`).
 * @returns The kebab-cased string, possibly empty.
 *
 * @example
 * ```ts
 * toKebabCase("  Árbol Grande!! "); // "arbol-grande"
 * ```
 */
export function toKebabCase(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Upper-cases the first letter of every whitespace-separated word and collapses whitespace.
 *
 * @param value - Value to convert.
 * @returns The title-cased string.
 */
export function toTitleCase(value: unknown): string {
  return String(value ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

/**
 * Trims a value and makes sure it ends with `.`, `!` or `?`.
 *
 * @param value - Text to normalise.
 * @returns The sentence, or `""` when the value is empty.
 */
export function ensureSentence(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Lower-cases the first character of a string.
 *
 * @param value - Text to transform.
 * @returns The text with a lower-case first character.
 */
export function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
