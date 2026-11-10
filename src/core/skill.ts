/**
 * Reading and editing `SKILL.md` files.
 *
 * @module
 */
import { isMap, isScalar, parseDocument, type Document } from "yaml";

import { fromLf, splitEol, type Eol } from "../util/eol.js";

/** `---` frontmatter block at the very start of the file (LF text). */
const FRONTMATTER_PATTERN = /^---\n(?:([\s\S]*?)\n)?---(?:\n|$)/;

/**
 * A parsed `SKILL.md`: YAML frontmatter plus a Markdown body.
 *
 * @remarks
 * - The frontmatter is kept as a `yaml` {@link Document}, so edits preserve comments, quoting
 *   and multi-line values.
 * - Frontmatter that was never modified is written back byte for byte. It is only re-serialised
 *   (without line folding) after {@link SkillFile.set} or {@link SkillFile.delete} change it.
 * - Content is handled with LF line endings; {@link SkillFile.toString} restores the original ending.
 *
 * @example
 * ```ts
 * const skill = SkillFile.parse(await fs.readFile("skills/front-x/SKILL.md", "utf8"));
 * skill.set(["description"], "Reviews UI changes.");
 * skill.setTitle("UI Review");
 * await fs.writeFile("skills/front-x/SKILL.md", skill.toString());
 * ```
 */
export class SkillFile {
  /** Line ending of the original file. */
  eol: Eol;
  /** Raw frontmatter text without the `---` delimiters, or `null` when the file has none. */
  frontmatterRaw: string | null;
  /** Parsed frontmatter, or `null` when the file has none. May hold parse errors. */
  doc: Document | null;
  /** Markdown after the frontmatter (LF). */
  body: string;
  private dirty = false;

  private constructor(eol: Eol, frontmatterRaw: string | null, body: string) {
    this.eol = eol;
    this.frontmatterRaw = frontmatterRaw;
    this.body = body;
    this.doc = frontmatterRaw === null ? null : parseDocument(frontmatterRaw);
  }

  /**
   * Parses `SKILL.md` content. Never throws: YAML problems are exposed through
   * {@link SkillFile.isValidYaml} and {@link SkillFile.yamlErrors}.
   *
   * @param content - File content with any line ending.
   * @returns The parsed file.
   */
  static parse(content: string): SkillFile {
    const { text, eol } = splitEol(content);
    const match = text.match(FRONTMATTER_PATTERN);
    if (!match) {
      return new SkillFile(eol, null, text);
    }
    return new SkillFile(eol, match[1] ?? "", text.slice(match[0].length));
  }

  /** Whether the file starts with a `---` frontmatter block. */
  get hasFrontmatter(): boolean {
    return this.frontmatterRaw !== null;
  }

  /** First line of each YAML parse error (empty when valid or missing). */
  get yamlErrors(): string[] {
    return this.doc ? this.doc.errors.map((error) => error.message.split("\n")[0]) : [];
  }

  /** Whether the frontmatter exists, parses without errors and is a mapping (or empty). */
  get isValidYaml(): boolean {
    return (
      this.doc !== null && this.doc.errors.length === 0 && (this.doc.contents === null || isMap(this.doc.contents))
    );
  }

  /**
   * @returns The frontmatter as plain JavaScript, or `{}` when it is missing or invalid.
   */
  data(): Record<string, unknown> {
    if (!this.isValidYaml) return {};
    const value = this.doc!.toJS();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  }

  /**
   * Reads a scalar frontmatter value as a trimmed string. Numbers and booleans are stringified.
   *
   * @param keyPath - Path of keys, e.g. `"description"` or `"metadata", "domain"`.
   * @returns The value, or `""` when it is missing, null, not a scalar or the YAML is invalid.
   */
  getString(...keyPath: string[]): string {
    if (!this.isValidYaml) return "";
    const node = this.doc!.getIn(keyPath, true);
    if (!isScalar(node) || node.value === null || node.value === undefined) return "";
    return String(node.value).trim();
  }

  /**
   * @param keyPath - Path of keys.
   * @returns Whether the key exists in valid frontmatter (whatever its value).
   */
  has(...keyPath: string[]): boolean {
    return this.isValidYaml && this.doc!.hasIn(keyPath);
  }

  private requireDoc(): Document {
    if (!this.doc || !this.isValidYaml) {
      throw new Error("SKILL.md has missing or invalid YAML frontmatter; fix it before editing.");
    }
    return this.doc;
  }

  /**
   * Sets a frontmatter value, creating intermediate maps as needed. Setting an existing scalar to
   * the same value is a no-op and keeps the original text untouched.
   *
   * @param keyPath - Path of keys, e.g. `["metadata", "domain"]`.
   * @param value - Any YAML-serialisable value.
   * @throws Error when the frontmatter is missing or invalid.
   */
  set(keyPath: string[], value: unknown): void {
    const doc = this.requireDoc();
    const current = doc.getIn(keyPath, true);
    if (isScalar(current)) {
      if (current.value === value) return;
      current.value = value;
    } else {
      doc.setIn(keyPath, value);
    }
    this.dirty = true;
  }

  /**
   * Removes a frontmatter key, if present.
   *
   * @param keyPath - Path of keys.
   * @throws Error when the frontmatter is missing or invalid.
   */
  delete(keyPath: string[]): void {
    const doc = this.requireDoc();
    if (doc.hasIn(keyPath)) {
      doc.deleteIn(keyPath);
      this.dirty = true;
    }
  }

  /**
   * Replaces the raw frontmatter text and re-parses it. Used by repairs that must fix text the
   * YAML parser cannot read (such as tab indentation).
   *
   * @param raw - New frontmatter text without delimiters (LF).
   */
  replaceFrontmatterRaw(raw: string): void {
    this.frontmatterRaw = raw;
    this.doc = parseDocument(raw);
    this.dirty = false;
  }

  /** Text of the first level-1 heading (`# Title`) of the body, or `""`. */
  get title(): string {
    const match = this.body.match(/^# (.+)$/m);
    return match ? match[1].trim() : "";
  }

  /**
   * Replaces the first level-1 heading, or inserts one at the top of the body when there is none.
   *
   * @param title - New heading text.
   */
  setTitle(title: string): void {
    if (/^# .*$/m.test(this.body)) {
      this.body = this.body.replace(/^# .*$/m, () => `# ${title}`);
    } else {
      this.body = `# ${title}\n\n${this.body.replace(/^\n+/, "")}`;
    }
  }

  /** @returns The full file content with LF line endings (used by validation). */
  toLfString(): string {
    if (this.frontmatterRaw === null) return this.body;
    const frontmatter = this.dirty ? this.doc!.toString({ lineWidth: 0 }).replace(/\n$/, "") : this.frontmatterRaw;
    return frontmatter ? `---\n${frontmatter}\n---\n${this.body}` : `---\n---\n${this.body}`;
  }

  /** @returns The full file content with the original line ending. */
  toString(): string {
    return fromLf(this.toLfString(), this.eol);
  }
}
