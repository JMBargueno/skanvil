/**
 * Regeneration and repair of the README skills index.
 *
 * - {@link rebuildIndex} rewrites whole sections. It backs `skanvil index`.
 * - {@link reconcileIndex} makes minimal edits. It backs `skanvil doctor --fix`.
 *
 * @module
 */
import type { Library, SkillInfo } from "./library.js";
import { buildEntry, findEntries, getEntry, insertEntry, removeEntry, setSection } from "./readme-index.js";

/** Skills of indexed categories grouped by category id, in folder order. */
async function indexedSkills(library: Library, readmeText: string): Promise<Map<string, SkillInfo[]>> {
  const result = new Map<string, SkillInfo[]>();
  for (const category of library.categories.indexed) result.set(category.id, []);
  for (const folder of await library.listSkillFolders()) {
    const category = library.categories.fromFolder(folder);
    if (!category.indexed) continue;
    result.get(category.id)!.push(await library.describeSkill(folder, readmeText));
  }
  return result;
}

/**
 * Regenerates every index section from the skills on disk.
 *
 * Rules:
 * - Each skill goes to the section of its category, and the section is created if needed.
 * - Entries already in the README keep their position and title.
 * - New skills are appended in alphabetical order.
 * - Descriptions come from the frontmatter.
 *
 * The output is stable: rebuilding a README produced by `add`/`edit` returns it unchanged,
 * which is what `skanvil index --check` relies on.
 *
 * @remarks Content inside each indexed category's `<details>` block is replaced. Text outside
 * those blocks is untouched.
 *
 * @param library - Library to index.
 * @param readmeText - Current README content (LF).
 * @returns The new README content (LF). Nothing is written.
 * @throws Error when a section has no closing `</details>` tag.
 */
export async function rebuildIndex(library: Library, readmeText: string): Promise<string> {
  const dir = library.skillsDirRef;
  const grouped = await indexedSkills(library, readmeText);
  const existingOrder = findEntries(readmeText, dir).entries.map((entry) => entry.skillName);
  let text = readmeText;

  for (const category of library.categories.indexed) {
    const skills = [...grouped.get(category.id)!].sort((a, b) => {
      const ia = existingOrder.indexOf(a.name);
      const ib = existingOrder.indexOf(b.name);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
    const entries = skills.map((skill) => {
      const existing = getEntry(readmeText, skill.name, dir);
      return buildEntry(
        { title: existing?.title || skill.title, description: skill.description, skillName: skill.name },
        dir
      );
    });
    text = setSection(text, category.title, entries);
  }
  return text;
}

/**
 * Repairs the README index with minimal edits:
 * - removes entries of skills that no longer exist;
 * - moves entries listed under the wrong category;
 * - appends entries for skills that are missing.
 *
 * Correct entries and any other content are left untouched.
 *
 * @param library - Library to reconcile.
 * @param readmeText - Current README content (LF).
 * @returns The new content (LF) and one human-readable line per change. Nothing is written.
 */
export async function reconcileIndex(
  library: Library,
  readmeText: string
): Promise<{ text: string; changes: string[] }> {
  const dir = library.skillsDirRef;
  const folders = new Set(await library.listSkillFolders());
  const changes: string[] = [];
  let text = readmeText;

  const documented = library.documentedByCategory(text);
  for (const [categoryId, names] of documented) {
    for (const name of names) {
      if (!folders.has(name)) {
        text = removeEntry(text, name, dir);
        changes.push(`removed README entry for missing skill ${name}`);
      } else if (library.categories.fromFolder(name).id !== categoryId) {
        text = removeEntry(text, name, dir);
        changes.push(`moved ${name} out of the ${library.categories.byId(categoryId)!.title} section`);
      }
    }
  }

  const stillDocumented = new Set<string>();
  for (const names of library.documentedByCategory(text).values()) for (const name of names) stillDocumented.add(name);

  for (const folder of folders) {
    const category = library.categories.fromFolder(folder);
    if (!category.indexed || stillDocumented.has(folder)) continue;
    const info = await library.describeSkill(folder, readmeText);
    text = insertEntry(
      text,
      category.title,
      buildEntry({ title: info.title, description: info.description, skillName: folder }, dir)
    );
    changes.push(`added ${folder} to the ${category.title} section`);
  }

  return { text, changes };
}
