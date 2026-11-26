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

const SEMANTIC_SYNONYMS: Record<string, string> = {
  audit: "review",
  review: "review",
  inspect: "review",
  check: "review",
  verify: "review",
  lint: "review",
  validat: "review",
  db: "database",
  database: "database",
  sql: "database",
  postgres: "database",
  postgresql: "database",
  mysql: "database",
  sqlite: "database",
  schema: "schema",
  migrat: "migration",
  migration: "migration",
  auth: "auth",
  authenticat: "auth",
  authoriz: "auth",
  login: "auth",
  oauth: "auth",
  jwt: "auth",
  sso: "auth",
  a11y: "a11y",
  accessib: "a11y",
  wcag: "a11y",
  aria: "a11y",
  ui: "frontend",
  frontend: "frontend",
  front: "frontend",
  react: "frontend",
  component: "frontend",
  view: "frontend",
  api: "api",
  http: "api",
  rest: "api",
  endpoint: "api",
  graphql: "api",
  perf: "performance",
  performanc: "performance",
  latenc: "performance",
  speed: "performance",
  optimiz: "performance",
  sec: "security",
  secur: "security",
  vulnerabil: "security",
  cve: "security",
  secret: "security",
  deploy: "deploy",
  releas: "deploy",
  publish: "deploy",
  pipelin: "deploy",
  test: "eval",
  eval: "eval",
  evaluat: "eval",
  benchmark: "eval",
  bug: "issue",
  issue: "issue",
  friction: "issue",
  error: "issue",
  failur: "issue",
  log: "report",
  record: "report",
  report: "report",
  track: "report",
  index: "index",
  tabl: "index"
};

function stemToken(token: string): string {
  let stem = token;
  if (stem.length > 5 && stem.endsWith("ation")) stem = stem.slice(0, -5);
  else if (stem.length > 4 && stem.endsWith("ies")) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 4 && stem.endsWith("ing")) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);
  else if (stem.length > 4 && stem.endsWith("es")) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith("s") && !stem.endsWith("ss")) stem = stem.slice(0, -1);
  return SEMANTIC_SYNONYMS[stem] ?? SEMANTIC_SYNONYMS[token] ?? stem;
}

/**
 * Normalizes text into stemmed, synonym-canonicalized semantic tokens for paraphrase detection.
 *
 * @param text - Input text such as a skill `name` and `description`.
 * @returns Sequence of canonical semantic tokens.
 */
export function canonicalizeSemanticTokens(text: string): string[] {
  return tokenizeForSimilarity(text).map(stemToken);
}

function sparseCosine(itemsA: readonly string[], itemsB: readonly string[]): number {
  if (itemsA.length === 0 || itemsB.length === 0) return 0;
  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();
  for (const item of itemsA) freqA.set(item, (freqA.get(item) ?? 0) + 1);
  for (const item of itemsB) freqB.set(item, (freqB.get(item) ?? 0) + 1);

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [key, countA] of freqA) {
    normA += countA * countA;
    const countB = freqB.get(key);
    if (countB) dot += countA * countB;
  }
  for (const countB of freqB.values()) normB += countB * countB;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function charTrigrams(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (cleaned.length < 3) return [];
  const out: string[] = [];
  for (let i = 0; i <= cleaned.length - 3; i += 1) {
    out.push(cleaned.slice(i, i + 3));
  }
  return out;
}

/**
 * Computes cosine similarity (`dot(A, B) / (|A| |B|)`) between two dense numeric vectors.
 *
 * @param vecA - First embedding vector.
 * @param vecB - Second embedding vector (must match length of `vecA`).
 * @returns Similarity in `[-1, 1]`, or `0` when vectors are empty or zero-norm.
 * @throws Error when vector dimensions differ.
 */
export function cosineSimilarity(vecA: readonly number[], vecB: readonly number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error(`Embedding dimension mismatch (${vecA.length} vs ${vecB.length}).`);
  }
  if (vecA.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Computes hybrid offline semantic similarity in `[0, 1]` combining stemmed synonym-canonicalized
 * token cosine similarity (`75%`) and character 3-gram cosine similarity (`25%`).
 *
 * @param textA - First description string.
 * @param textB - Second description string.
 * @returns Semantic similarity score in `[0, 1]`.
 */
export function semanticSimilarity(textA: string, textB: string): number {
  const tokensA = canonicalizeSemanticTokens(textA);
  const tokensB = canonicalizeSemanticTokens(textB);
  if (new Set(tokensA).size < 3 || new Set(tokensB).size < 3) return 0;
  const tokenScore = sparseCosine(tokensA, tokensB);
  const trigramScore = sparseCosine(charTrigrams(tokensA.join(" ")), charTrigrams(tokensB.join(" ")));
  return 0.75 * tokenScore + 0.25 * trigramScore;
}
