---
name: skanvil
description: Operate skanvil, the CLI that manages libraries of Agent Skills (a skills/ folder of SKILL.md files, a README index and a .skanvilrc.json). Use it whenever you create, rename, re-categorise, delete, validate or index skills in a repository that has a .skanvilrc.json or depends on skanvil, when fixing skanvil validation errors, or when installing skills into a project's .claude/skills, .github/skills or .agents/skills folders.
metadata:
  author: skanvil
  version: "1.0"
---

# skanvil

## Objective

Change skills libraries through the `skanvil` CLI, so that skill folders, the `SKILL.md` frontmatter, the README index and the library conventions stay consistent and validation stays green.

## When to Activate This Skill

- The repository has a `.skanvilrc.json`, a `skills/` folder of `SKILL.md` files, or `skanvil` in its `package.json`.
- The user asks to add, write, rename, move, retitle, redescribe, delete, list, validate or index skills.
- `skanvil validate`, `npm test` or CI fails with skanvil diagnostics.
- The user wants a library's skills available to Claude Code, GitHub Copilot or Codex in another project.

## Instructions

### 1. Orient yourself

1. Read `.skanvilrc.json`. It defines the categories (`id`, folder `prefix`, README `title`, `aliases`), the required sections, placeholders and rule severities. A missing file means the default preset: `front-`, `back-`, prefix-less `transversal` (the default) and `_internal`.
2. Run `npx skanvil list --json` to see every skill with its category, README presence and validity.
3. Run `npx skanvil validate --json` before changing anything, so you know which problems already existed.

### 2. Golden rules

- **Never rename, move or delete skill folders by hand, and never hand-edit the README index.** Use `skanvil edit`, which keeps the folder, the frontmatter `name`, the `# heading` and the README entry in sync, and rolls back on failure.
- **Never create skill folders by hand.** Use `skanvil add`, which applies the category prefix, the template, the frontmatter metadata and the README entry.
- **Always pass every option in non-interactive shells.** `add` needs `--type`, `--name` and `--description`. `edit --remove` needs `--yes`. Otherwise the command prompts, or fails without a TTY.
- Add `--json` whenever you need to parse output. Data goes to stdout; warnings and errors go to stderr.
- Run `npx skanvil validate` after every change and finish with no errors. Exit code `1` means errors, or warnings when `--strict` is used.
- Prefix every command with `npx` unless `skanvil` is on PATH. Use `-C <path>` to target a library in another folder.

### 3. Common tasks

**Create a skill, then write its content.**

```bash
npx skanvil add --type <category> --name "<short name>" \
  --description "<what it does>. Use when <trigger situations>."
```

Then edit `skills/<prefix><name>/SKILL.md`:

- Fill every required section with concrete, actionable content.
- Replace all the generic template sentences. Until you do, `validate` reports a `template-unchanged` warning, and `validate --strict` (the library's `npm test`) fails.
- Move long material into `references/`, and link only to files that exist (`broken-references`).

Use `--no-scripts`, `--no-assets` or `--no-references` when those folders would stay empty. Use `--template <name>` for a custom template in `.skanvil/templates/`.

**Rename or move a skill.**

```bash
npx skanvil edit <skill> --rename <new-name>          # prefix is re-applied automatically
npx skanvil edit <skill> --type <other-category>      # new prefix, README section, metadata
npx skanvil edit <skill> --title "<Title>" --description "<text>"
```

`--rename` takes the base name: `edit front-a --rename b` gives `front-b`.

**Delete a skill.** Confirm with the user first; this is permanent.

```bash
npx skanvil edit <skill> --remove --yes
```

**Fix validation errors.**

1. Run `npx skanvil doctor --fix`. It repairs README entries, `name` mismatches, tabs in the frontmatter and converts `tools` to `allowed-tools`.
2. Fix what remains by editing `SKILL.md`. Use the diagnostic table below.
3. Run `npx skanvil validate` again.

**Rebuild the README index** after changing category titles in `.skanvilrc.json`:

```bash
npx skanvil index          # rewrites the index sections
npx skanvil index --check  # verify only (CI)
```

**Install the skills into a project.**

```bash
npx skanvil sync <project-dir> -C <library-dir> --target claude,copilot --dry-run   # preview
npx skanvil sync <project-dir> -C <library-dir> --target claude,copilot
npx skanvil sync --from @scope/package --target agents                             # installed package
```

Targets:

- `claude` installs into `.claude/skills`;
- `copilot` installs into `.github/skills`;
- `agents` and `codex` install into `.agents/skills`.
- A custom path must be a folder inside the project.
- `--global` (with no project dir) installs into the user's `~/.claude/skills`, `~/.copilot/skills` or `~/.agents/skills` instead. Only use it when the user asks for skills available in every project.

How sync behaves:

- It never overwrites folders it did not install.
- It prunes skills that were removed from the library.
- It skips skills with validation errors unless `--force` is given.
- It never publishes `_internal` skills.

**Add or change categories.** Edit `categories` in `.skanvilrc.json`:

- exactly one category has `"default": true` and no prefix;
- every other category has a prefix that is `_` or kebab-case ending in `-`;
- no prefix may start with another prefix.

Then move existing skills with `edit --type`, and run `skanvil index`.

### 4. Write good skill content

- **`description`** says _what_ the skill does and _when_ to use it, with the trigger keywords an agent would see. It must be at most 1024 characters.
- **`name`** equals the folder name: lowercase letters, digits and single hyphens, at most 64 characters.
- **Body:** keep `SKILL.md` under 500 lines. Write instructions as numbered, verifiable steps, and put examples, edge cases and long checklists in `references/` (one level deep).
- **Placeholders:** never leave filler text. Any entry of `validation.placeholders` (to-do markers, dummy Latin text, "to be decided" notes) fails validation.
- **`metadata`:** string values only, so quote numbers, as in `version: "1.0"`.
- **`allowed-tools`:** a space-separated string, not a list.

### 5. Diagnostic → fix

| Rule                                                | Fix                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `readme-missing`, `readme-orphan`, `readme-section` | `npx skanvil doctor --fix`                                                     |
| `name-matches-folder`, `name-required`              | `doctor --fix`, or `edit --rename` if the folder name is wrong                 |
| `frontmatter-tabs`, `tools-field`                   | `doctor --fix`                                                                 |
| `frontmatter`                                       | Repair the YAML between the `---` lines (quote values containing `: ` or `#`). |
| `required-sections`                                 | Add the missing `## Section` listed in `validation.requiredSections`.          |
| `placeholders`                                      | Replace the placeholder text with real content.                                |
| `description-length`, `max-lines`                   | Shorten; move detail to `references/`.                                         |
| `metadata-format`                                   | Quote non-string values.                                                       |
| `duplicate-name`                                    | Two folders share a `name`: rename one with `edit --rename`.                   |
| `broken-references`                                 | Create the referenced file, or fix the link (paths are relative to the skill). |
| `template-unchanged`                                | Rewrite the generic scaffold sentences with skill-specific instructions.       |

See [references/REFERENCE.md](references/REFERENCE.md) for every command option, the config schema and JSON output shapes.

## Output Format

Report to the user:

- the skanvil commands you ran;
- the skills created, changed or removed, with their folder names;
- the final `skanvil validate` result (errors and warnings), and anything left for them to decide.

## Quality Criteria

- Every structural change went through `skanvil add` or `skanvil edit`. There are no hand-made folder renames or README index edits.
- `npx skanvil validate` reports no errors, and `npx skanvil index --check` passes.
- New or edited skills have specific descriptions with triggers, and no template filler or placeholders.
- Deletions and syncs into other projects were confirmed with the user.
