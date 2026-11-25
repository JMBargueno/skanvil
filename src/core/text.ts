/**
 * Pure text, token-estimation, Markdown-section and similarity helpers.
 *
 * All helpers are deterministic and dependency-free.
 *
 * @module
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "when",
  "use",
  "this",
  "skill",
  "is",
  "are",
  "be",
  "by",
  "it",
  "that",
  "as",
  "at",
  "from",
  "into",
  "your",
  "you",
  "its",
  "their",
  "our",
  "can",
  "will",
  "should",
  "must",
  "any",
  "all"
]);

/**
 * Estimates the token count of a piece of text using an approximate ~4-characters-per-token
 * heuristic.
 *
 * @remarks Deterministic and model-agnostic so token budgets work offline with zero dependencies.
 *
 * @param text - Input text.
 * @returns Estimated token count (`0` for empty or whitespace-only text).
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed ? Math.ceil(trimmed.length / 4) : 0;
}

/**
 * Removes fenced code blocks (`` ``` `` and `~~~`) from Markdown text while keeping surrounding
 * text intact.
 *
 * @param markdown - Markdown content (LF or CRLF).
 * @returns Markdown with fenced code blocks stripped.
 */
export function stripFencedCode(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (fenceChar === null) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (open) {
        const marker = open[1];
        const info = open[2];
        // CommonMark: backtick info strings cannot contain backticks.
        if (!(marker[0] === "`" && info.includes("`"))) {
          fenceChar = marker[0] as "`" | "~";
          fenceLen = marker.length;
          continue;
        }
      }
      out.push(line);
    } else {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }
  return out.join("\n");
}

/**
 * Extracts the content under the first matching level-2 Markdown heading (`## Heading`) outside
 * fenced code blocks, up to the next level-2 heading or the end of the body.
 *
 * @param body - Markdown body (LF or CRLF).
 * @param headings - Candidate heading titles compared case-insensitively.
 * @returns The section body (excluding the `## Heading` line itself), or `null` if not found.
 */
export function extractSection(body: string, headings: readonly string[]): string | null {
  const targets = new Set(headings.map((heading) => heading.trim().toLowerCase()));
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  let start = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fenceChar === null) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        fenceChar = open[1][0] as "`" | "~";
        fenceLen = open[1].length;
        continue;
      }
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        if (start !== -1) {
          return lines.slice(start, i).join("\n");
        }
        if (targets.has(heading[1].trim().toLowerCase())) {
          start = i + 1;
        }
      }
    } else {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }

  return start === -1 ? null : lines.slice(start).join("\n");
}

/**
 * Normalises text into content tokens for similarity and lexical routing checks: lower-cased,
 * split on non-alphanumerics, single-character tokens dropped, and common English stopwords removed.
 *
 * @param text - Input text.
 * @returns Array of normalised tokens (preserving multiplicity for term-frequency scoring).
 */
export function tokenizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/**
 * Computes Jaccard similarity (`|A ∩ B| / |A ∪ B|`) between two token sequences treated as sets.
 *
 * @param tokensA - First token sequence.
 * @param tokensB - Second token sequence.
 * @returns Similarity in `[0, 1]` (`0` when both sets are empty).
 */
export function jaccardSimilarity(tokensA: readonly string[], tokensB: readonly string[]): number {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
