/**
 * Pure helpers for the skills index in the README.
 *
 * Every function works on LF text and returns new text; callers handle CRLF and file I/O
 * (see {@link Library.readReadme}). The format is:
 *
 * ```md
 * <details>
 * <summary><strong>Front</strong></summary>
 *
 * - Title
 * \t- Description: Does things.
 * \t- Folder: `skills/front-name`
 *
 * </details>
 * ```
 *
 * A section is identified by the title inside `<summary><strong>…</strong></summary>`, and an
 * entry by its `Folder:` line.
 *
 * @module
 */
import { ensureSentence, escapeRegex } from "./naming.js";

const SUMMARY_PATTERN = /<summary><strong>(.+?)<\/strong><\/summary>/;

/** An index entry found in the README. */
export interface IndexEntry {
  /** Title of the section holding the entry. */
  section: string;
  /** Index of the entry's first line (0-based). */
  start: number;
  /** Index of the line after the entry (exclusive). */
  end: number;
  /** Entry title (the `- Title` line). */
  title: string;
  /** Text after `Description:`, or `""`. */
  description: string;
  /** Folder name from the `Folder:` line, or `""` when it has none. */
  skillName: string;
}

/** Data needed to build an index entry. */
export interface EntryInput {
  /** Display title. */
  title: string;
  /** Description; whitespace is collapsed and a final period added. */
  description: string;
  /** Skill folder name. */
  skillName: string;
}

function folderPattern(skillsDir: string): RegExp {
  return new RegExp(`Folder:\\s*\`${escapeRegex(skillsDir)}\\/([^\`/]+)\``);
}

/**
 * Builds the text of an index entry. Multi-line titles and descriptions (from YAML `|`/`>`
 * scalars) are collapsed to one line so the entry stays parseable.
 *
 * @param entry - Title, description and folder name.
 * @param skillsDir - Skills folder as written in the README. @defaultValue `"skills"`
 * @returns Three lines joined with `\n`.
 *
 * @example
 * ```ts
 * buildEntry({ title: "Demo", description: "Does things", skillName: "front-demo" });
 * // "- Demo\n\t- Description: Does things.\n\t- Folder: `skills/front-demo`"
 * ```
 */
export function buildEntry({ title, description, skillName }: EntryInput, skillsDir = "skills"): string {
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  return [
    `- ${oneLine(title)}`,
    `\t- Description: ${ensureSentence(oneLine(description))}`,
    `\t- Folder: \`${skillsDir}/${skillName}\``
  ].join("\n");
}

/**
 * Finds every index entry inside `<details>` sections. An entry is a `- ` line plus the indented
 * lines that follow it.
 *
 * @param content - README text (LF).
 * @param skillsDir - Skills folder as written in the README. @defaultValue `"skills"`
 * @returns The README split into lines, and the entries with their line ranges.
 */
export function findEntries(content: string, skillsDir = "skills"): { lines: string[]; entries: IndexEntry[] } {
  const lines = content.split("\n");
  const entries: IndexEntry[] = [];
  const folder = folderPattern(skillsDir);
  let section: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const summary = lines[i].match(SUMMARY_PATTERN);
    if (summary) {
      section = summary[1];
      continue;
    }
    if (lines[i].includes("</details>")) {
      section = null;
      continue;
    }
    if (section && /^- /.test(lines[i])) {
      let end = i + 1;
      while (end < lines.length && /^\s+\S/.test(lines[end])) {
        end += 1;
      }
      const text = lines.slice(i, end).join("\n");
      const folderMatch = text.match(folder);
      entries.push({
        section,
        start: i,
        end,
        title: lines[i].slice(2).trim(),
        description: ((text.match(/Description:\s*(.+)/) || [])[1] || "").trim(),
        skillName: folderMatch ? folderMatch[1] : ""
      });
      i = end - 1;
    }
  }

  return { lines, entries };
}

/**
 * @param content - README text (LF).
 * @param skillName - Skill folder name.
 * @param skillsDir - Skills folder as written in the README. @defaultValue `"skills"`
 * @returns The entry of the skill, or `null` when it is not listed.
 */
export function getEntry(content: string, skillName: string, skillsDir = "skills"): IndexEntry | null {
  return findEntries(content, skillsDir).entries.find((entry) => entry.skillName === skillName) || null;
}

/**
 * Removes the entry of a skill. A blank line left between two blank lines is removed too.
 *
 * @param content - README text (LF).
 * @param skillName - Skill folder name.
 * @param skillsDir - Skills folder as written in the README. @defaultValue `"skills"`
 * @returns The new text, unchanged when the skill is not listed.
 */
export function removeEntry(content: string, skillName: string, skillsDir = "skills"): string {
  const { lines, entries } = findEntries(content, skillsDir);
  const entry = entries.find((candidate) => candidate.skillName === skillName);
  if (!entry) {
    return content;
  }
  lines.splice(entry.start, entry.end - entry.start);
  // Avoid leaving two consecutive blank lines where the entry used to be.
  const before = lines[entry.start - 1];
  const after = lines[entry.start];
  if (before !== undefined && before.trim() === "" && after !== undefined && after.trim() === "") {
    lines.splice(entry.start, 1);
  }
  return lines.join("\n");
}

/**
 * Replaces the entry of a skill in place (same section, same position).
 *
 * @param content - README text (LF).
 * @param skillName - Folder name of the entry to replace.
 * @param entryText - New entry, usually from {@link buildEntry}.
 * @param skillsDir - Skills folder as written in the README. @defaultValue `"skills"`
 * @returns The new text, unchanged when the skill is not listed.
 */
export function replaceEntry(content: string, skillName: string, entryText: string, skillsDir = "skills"): string {
  const { lines, entries } = findEntries(content, skillsDir);
  const entry = entries.find((candidate) => candidate.skillName === skillName);
  if (!entry) {
    return content;
  }
  lines.splice(entry.start, entry.end - entry.start, ...entryText.split("\n"));
  return lines.join("\n");
}

function summaryMarker(sectionTitle: string): string {
  return `<summary><strong>${sectionTitle}</strong></summary>`;
}

/**
 * Appends an entry at the end of a section. When the section does not exist, a new
 * `<details>` block is appended to the end of the README.
 *
 * @param content - README text (LF).
 * @param sectionTitle - Section title, e.g. `"Backend"`.
 * @param entryText - Entry from {@link buildEntry}.
 * @returns The new text.
 * @throws Error when the section has no closing `</details>` tag.
 */
export function insertEntry(content: string, sectionTitle: string, entryText: string): string {
  const marker = summaryMarker(sectionTitle);
  const blockStart = content.indexOf(marker);

  if (blockStart === -1) {
    const block = `<details>\n${marker}\n\n${entryText}\n\n</details>\n`;
    return `${content.trimEnd()}\n\n${block}`;
  }

  const blockEnd = content.indexOf("</details>", blockStart);
  if (blockEnd === -1) {
    throw new Error(`README closing </details> tag not found for section '${sectionTitle}'.`);
  }

  const beforeClose = content.slice(0, blockEnd).trimEnd();
  // Markdown inside <details> needs a blank line after <summary>.
  const separator = beforeClose.endsWith("</summary>") ? "\n\n" : "\n";
  return `${beforeClose}${separator}${entryText}\n\n${content.slice(blockEnd)}`;
}

/**
 * Replaces the whole body of a section with the given entries. The output is identical to
 * inserting the same entries one by one with {@link insertEntry}.
 *
 * @remarks Any hand-written content inside that `<details>` block is lost.
 *
 * @param content - README text (LF).
 * @param sectionTitle - Section title.
 * @param entryTexts - Entries from {@link buildEntry}, in display order.
 * @returns The new text. A missing section is created only when there are entries.
 * @throws Error when the section has no closing `</details>` tag.
 */
export function setSection(content: string, sectionTitle: string, entryTexts: string[]): string {
  const marker = summaryMarker(sectionTitle);
  const body = entryTexts.length > 0 ? `\n\n${entryTexts.join("\n")}\n\n` : "\n\n";
  const blockStart = content.indexOf(marker);

  if (blockStart === -1) {
    if (entryTexts.length === 0) return content;
    return `${content.trimEnd()}\n\n<details>\n${marker}${body}</details>\n`;
  }

  const bodyStart = blockStart + marker.length;
  const blockEnd = content.indexOf("</details>", bodyStart);
  if (blockEnd === -1) {
    throw new Error(`README closing </details> tag not found for section '${sectionTitle}'.`);
  }
  return `${content.slice(0, bodyStart)}${body}${content.slice(blockEnd)}`;
}

/**
 * Collects the skill folders referenced in each section. Any `<skillsDir>/<name>` mention inside
 * the block counts, so hand-written entries are detected too.
 *
 * @param content - README text (LF).
 * @param sectionTitles - Titles of the sections to read (matched case-insensitively).
 * @param skillsDir - Skills folder as written in the README. @defaultValue `"skills"`
 * @returns Folder names keyed by section title. Missing sections map to an empty set.
 */
export function parseIndex(content: string, sectionTitles: string[], skillsDir = "skills"): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const folder = new RegExp(`${escapeRegex(skillsDir)}\\/([a-z0-9_-]+)`, "gi");

  for (const title of sectionTitles) {
    const names = new Set<string>();
    result.set(title, names);
    const blockPattern = new RegExp(
      `<summary><strong>${escapeRegex(title)}<\\/strong><\\/summary>[\\s\\S]*?<\\/details>`,
      "i"
    );
    const block = content.match(blockPattern);
    if (!block) continue;
    for (const match of block[0].matchAll(folder)) {
      names.add(match[1]);
    }
  }

  return result;
}

/**
 * Builds empty `<details>` sections, as written by `skanvil init`.
 *
 * @param sectionTitles - Section titles in display order.
 * @returns The sections separated by blank lines.
 */
export function buildSections(sectionTitles: string[]): string {
  return sectionTitles.map((title) => `<details>\n${summaryMarker(title)}\n\n</details>`).join("\n\n");
}
