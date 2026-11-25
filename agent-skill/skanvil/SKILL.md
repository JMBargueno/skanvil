---
name: skanvil
description: Operate skanvil to create, edit, validate, measure, evaluate and sync Agent Skill libraries (skills/, README.md, .skanvilrc.json). Use whenever managing skills in a library repository, running stats or evals, fixing validation diagnostics, or installing skills into .claude/skills, .github/skills or .agents/skills.
metadata:
  author: skanvil
  version: "1.0"
---

# skanvil

## Objective

Change skills libraries through the `skanvil` CLI, so that skill folders, `SKILL.md` frontmatter, the README index, context budgets, evaluations and lifecycle metadata stay consistent and validation stays green.

## When to Activate This Skill

- The repository has a `.skanvilrc.json`, a `skills/` folder of `SKILL.md` files, or `skanvil` in its `package.json`.
- The user asks to add, write, rename, move, retitle, redescribe, deprecate, delete, list, validate, measure, evaluate or sync skills.
- `skanvil validate`, `skanvil eval triggers`, `npm test` or CI fails with skanvil diagnostics.
- Do not activate for ordinary application code changes unrelated to managing or installing Agent Skills.

## Instructions

### 1. Orient yourself

1. Read `.skanvilrc.json`. It defines the categories (`id`, folder `prefix`, README `title`, `aliases`), required sections, token/line budgets, placeholders and rule severities. A missing file means the default preset: `front-`, `back-`, prefix-less `transversal` (the default) and `_internal`.
2. Run `npx skanvil list --json` to inspect every skill with its category, README presence, validity, status and owner.
3. Run `npx skanvil validate --json` and `npx skanvil stats --json` before changing anything, so you know existing diagnostics and token budgets.

### 2. Golden rules

- **Never rename, move or delete skill folders by hand, and never hand-edit the README index.** Use `skanvil edit`, which keeps the folder, the frontmatter `name`, the `# heading` and the README entry in sync, and rolls back on failure.
- **Never create skill folders by hand.** Use `skanvil add`, which applies the category prefix, the template, the frontmatter metadata and the README entry.
- **Always pass every option in non-interactive shells.** `add` needs `--type`, `--name` and `--description`. `edit --remove` needs `--yes`. Otherwise the command prompts, or fails without a TTY.
- **Never run `skanvil` without arguments or `skanvil wizard`.** They open an interactive menu meant for humans. Use the explicit commands below. If the user prefers menus, suggest they run `npx skanvil` themselves.
- Add `--json` whenever you need to parse output. Data goes to stdout; warnings and errors go to stderr.
- Run `npx skanvil validate` after every change and finish with no errors. Exit code `1` means errors, or warnings when `--strict` is used.
- Prefix every command with `npx` unless `skanvil` is on PATH. Use `-C <path>` to target a library in another folder.

### 3. Common tasks

**Create a skill, then write its content.**

```bash
npx skanvil add --type <category> --name "<short name>" \
  --description "<what it does>. Use when <trigger situations>; do not use for <exclusions>."
```

Then edit `skills/<prefix><name>/SKILL.md`:

- Fill every required section (including `## Error Recovery`) with concrete, actionable content.
- Replace all generic template sentences, including the scaffold row in `## Error Recovery`. Until you do, `validate` reports `template-unchanged`, and `validate --strict` fails.
- Move long material into `references/`, and link every file in `references/`, `scripts/` and `assets/` from `SKILL.md` (`broken-references`, `unused-resources`).

Use `--no-scripts`, `--no-assets` or `--no-references` when those folders would stay empty. Use `--template <name>` for a custom template in `.skanvil/templates/`.

To onboard existing skill folders from another project or `.claude/skills` directory, run:

```bash
npx skanvil import <sourceDir> --type <category> --dry-run
npx skanvil import <sourceDir> --type <category>
```

**Rename, move, assign owner or deprecate a skill.**

```bash
npx skanvil edit <skill> --rename <new-name>                   # prefix is re-applied automatically
npx skanvil edit <skill> --type <other-category>               # new prefix, README section, metadata
npx skanvil edit <skill> --owner "@platform-team" --status active
npx skanvil edit <skill> --status deprecated --replaced-by <other-skill>
```

`--rename` takes the base name: `edit front-a --rename b` gives `front-b`. `--replaced-by` implies `--status deprecated`.

**Delete a skill.** Confirm with the user first; this is permanent.

```bash
npx skanvil edit <skill> --remove --yes
```

**Inspect 3-stage token budgets and fix validation issues.**

1. Run `npx skanvil stats --sort tokens` to review Stage-1 (`name` + `description`), Stage-2 (`SKILL.md` lines/tokens) and Stage-3 (`references/`, `scripts/`, `assets/`) sizes.
2. Run `npx skanvil doctor --fix` to repair README entries, `name` mismatches, frontmatter tabs and `tools` → `allowed-tools` (add `--scaffold-sections` to insert minimal stubs for missing required headings).
3. Fix remaining diagnostics in `SKILL.md` using the Error Recovery table below, then run `npx skanvil validate` (or `--format github` / `--format sarif` in CI).
4. Compare branch changes before opening PRs with `npx skanvil diff [baseRef] --format markdown`.

**Test trigger routing, simulate prompts, and promote feedback (`evals.json`).**

```bash
npx skanvil eval route "<user prompt>" --top 3                  # test routing interactively
npx skanvil eval triggers --strict                             # offline BM25 collision check
npx skanvil eval triggers --split eval --strict
npx skanvil eval export --format promptfoo --ablation --out evals.promptfoo.json
npx skanvil feedback list
npx skanvil feedback promote --prune
```

When `.skanvil-feedback.jsonl` records a failing skill session with a `suggestedEvalCase`, run `npx skanvil feedback promote --prune` to capture the regression in `evals.json` before editing instructions. `evals.json` is excluded from `sync` and `build`, so tests never add runtime token overhead.

**Rebuild the README index** after changing category titles in `.skanvilrc.json`:

```bash
npx skanvil index          # rewrites the index sections
npx skanvil index --check  # verify only (CI)
```

**Install skills into a project.**

```bash
npx skanvil sync <project-dir> -C <library-dir> --target claude,copilot --dry-run
npx skanvil sync <project-dir> -C <library-dir> --target claude,cursor
npx skanvil sync --from @scope/package --target agents
npx skanvil sync --from github:org/repo#v1 --target claude
```

Presets: `claude` (`.claude/skills`), `copilot` (`.github/skills`), `agents` / `codex` (`.agents/skills`), `cursor` (`.cursor/skills`), `opencode` (`.opencode/skills`), `windsurf` (`.windsurf/skills`), `gemini` (`.gemini/skills`), or a relative path inside the project. `--global` installs into user home directories. Manifest v2 lets multiple libraries coexist in one target folder without overwriting or pruning each other's skills. `sync` skips `deprecated` skills by default (`--include-deprecated` overrides) and never overwrites foreign folders.

**Add or change categories.** Edit `categories` in `.skanvilrc.json` (one `default: true` with empty prefix, non-ambiguous prefixes ending in `-` or `_`), move skills with `edit --type`, and run `skanvil index`.

**Parametrize and export skills.** Add `params.json` with `enum` / `string` / `boolean` definitions (each with a `default`), use `{{name}}` and `{{#if ...}}` in `SKILL.md`, validate with `npx skanvil validate`, install with `sync --param key=value`, or run `npx skanvil build` for typed npm exports.

### 4. Write good skill content

- **`description` (Stage 1, always loaded):** Keep `name` + `description` within ~120 estimated tokens (`description-budget`). State _what_ it does, _when_ to activate it, and what to exclude (`description-triggers`), while keeping distinct keywords from sibling skills (`description-overlap`).
- **`name`:** Equals the folder name: lowercase letters, digits and single hyphens, at most 64 characters.
- **Body (Stage 2):** Keep `SKILL.md` under 500 lines (`max-lines`). Use numbered steps in `## Instructions` (`numbered-steps`), each with a single objective and an explicit verification check.
- **Error Recovery (Stage 2):** Document concrete failure modes and fixes in a Markdown table (`error-recovery-table`). Never write vague fallback instructions (`vague-fallback`).
- **Resources (Stage 3):** Put long checklists and edge cases in `references/` (one level deep) and link every bundled file (`unused-resources`, `broken-references`).
- **Placeholders & YAML:** Never leave filler text (`placeholders`). Quote numeric `metadata` values (`version: "1.0"`). Write `allowed-tools` as a space-separated string.

## Error Recovery

| Failure / Rule                                                                                                                 | Cause                                                                      | Recovery Action                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `readme-missing`, `readme-orphan`, `readme-section`, `name-matches-folder`, `name-required`, `frontmatter-tabs`, `tools-field` | Structural or frontmatter drift                                            | Run `npx skanvil doctor --fix`; if a folder name itself is wrong, rename it with `npx skanvil edit <skill> --rename <new>`.            |
| `frontmatter`                                                                                                                  | Malformed YAML between `---` lines                                         | Quote values containing `: ` or `#`, remove tabs, and verify valid YAML mapping syntax.                                                |
| `required-sections`                                                                                                            | Missing `## Heading` from `validation.requiredSections`                    | Add the missing level-2 headings (including `## Error Recovery`) with skill-specific content.                                          |
| `placeholders`, `template-unchanged`                                                                                           | Unreplaced filler or scaffold sentences                                    | Replace every generic scaffold sentence and forbidden placeholder with concrete instructions.                                          |
| `description-length`, `description-budget`, `max-lines`                                                                        | Oversized metadata or body                                                 | Tighten `description` under ~120 tokens (`name` + `description`) and move deep detail to `references/`.                                |
| `description-triggers`, `description-overlap`                                                                                  | Missing trigger cues or overlapping siblings                               | Add explicit `"Use when ..."` and exclusion boundaries with keywords that distinguish sibling skills.                                  |
| `numbered-steps`, `error-recovery-table`, `vague-fallback`                                                                     | Unstructured instructions or weak recovery advice                          | Number `## Instructions` steps (`1.`, `2.`), add a `## Error Recovery` Markdown table, and replace vague retries with explicit checks. |
| `broken-references`, `unused-resources`                                                                                        | Missing link target or unlinked file in `references/`/`scripts/`/`assets/` | Link existing files from `SKILL.md` with relative paths, or remove unused files.                                                       |
| `evals-file`, `evals-required`, `duplicate-trigger`                                                                            | Invalid `evals.json`, missing triggers, or duplicate `shouldTrigger`       | Fix schema (kebab-case `cases[].id`, valid `params`) and ensure positive trigger prompts are distinct per skill.                       |
| `no-secrets`, `no-local-paths`                                                                                                 | Hardcoded credential pattern or personal home directory path               | Replace hardcoded credentials with env vars and rewrite machine home paths into relative paths or generic placeholders.                |
| `owner-required`, `status-valid`, `replaced-by-exists`                                                                         | Missing or invalid lifecycle metadata                                      | Set `metadata.owner`, use `draft`/`experimental`/`active`/`deprecated`, and point `metadata.replaced-by` to an active skill.           |
| Non-interactive prompt failure                                                                                                 | `add` or `edit --remove` called without required flags                     | Pass `--type`, `--name` and `--description` to `add`, or `--yes` to `edit --remove`.                                                   |

See [references/REFERENCE.md](references/REFERENCE.md) for every command option, the config schema, `evals.json` format and JSON output shapes.

## Output Format

Report to the user:

- the `skanvil` commands you ran;
- the skills created, changed, evaluated or removed, with their folder names;
- the final `skanvil validate` (and `skanvil eval triggers` if run) result, plus any follow-up actions.

## Quality Criteria

- Every structural change went through `skanvil add` or `skanvil edit`. There are no hand-made folder renames or README index edits.
- `npx skanvil validate --strict` reports no errors or warnings, and `npx skanvil index --check` passes.
- Every skill stays concise in Stage 1 (`description-budget`), uses concrete steps and an `## Error Recovery` table, and has no unused or broken resource links.
- Deletions and syncs into other projects were confirmed with the user.
