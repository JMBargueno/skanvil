# Command reference

```text
skanvil <command> [options]
```

**Global options:**

- `-h, --help` shows help.
- `--version` prints the version.
- Running `skanvil` without a command opens the [wizard](#wizard) in an interactive terminal. In CI or a pipe it prints the help and exits with code 1.

**Common options:**

| Option             | Description                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-C, --cwd <path>` | Library root. Default: the current directory. For `sync`, this is the _source_ library. Every command except `wizard` and `install-skill` accepts it.                                       |
| `--json`           | Print machine-readable JSON on stdout. Informational text is suppressed; warnings and errors still go to stderr. Accepted by every command except `wizard` and `eval export` (always JSON). |

**Exit codes:**

- `0`: success.
- `1`: any error, such as invalid arguments, validation errors, or a failed check or operation. Errors are printed as `skanvil: <message>`.

---

## `wizard`

An interactive assistant. `skanvil` runs it when called with no arguments in a terminal, and `skanvil wizard` starts it explicitly. It needs a TTY: without one it fails with exit code 1.

The menu depends on the current folder:

| Where             | Actions                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Outside a library | Create a library (default preset, your own categories, or no categories, optionally choosing whether to install `skanvil` and `skanvil-feedback`); install skills from a library; install the agent skills.                                                                                      |
| Inside a library  | Add a skill; edit, rename, move, set owner/status, deprecate or delete one; list skills; check and repair the library; inspect 3-stage token budgets (`stats`); check trigger routing (`eval triggers`); install the skills into a project or for your user; install or update the agent skills. |

How it behaves:

- After creating a library, the wizard continues inside it.
- Installs always show a dry-run preview and ask before writing.
- Deleting a skill asks for confirmation.
- After every action it prints the equivalent command with all its flags.
- An error inside an action is reported and the menu comes back.
- Ctrl+C or **Exit** ends the wizard.

## `init [dir]`

Create a new library in `dir`. If `dir` is omitted, `--cwd` or the current directory is used. The folder must be empty or not exist.

| Option                  | Description                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <value>`        | Library and package name, kebab-cased. Default: the folder name.                                                                                        |
| `--scope <value>`       | npm scope (`acme` or `@acme`). The package becomes `@acme/<name>`.                                                                                      |
| `--description <value>` | Description for the README and package.json.                                                                                                            |
| `--profile <list>`      | README sections to create from the default preset: any of `front,back,transversal`, or `all` (default). Aliases such as `backend` work.                 |
| `--no-git`              | Do not run `git init`.                                                                                                                                  |
| `--eject-templates`     | Also copy the skill template to `.skanvil/templates/skill`.                                                                                             |
| `--no-agent-skill`      | Do not install the [`skanvil` agent skill](#install-skill-dest) into the library. By default it goes to `.claude/skills/skanvil`.                       |
| `--no-feedback`         | Do not install `skanvil-feedback` alongside `skanvil`.                                                                                                  |
| `--target <name>`       | Default sync targets written to `.skanvilrc.json`, which are also where the agent skill is installed. Repeatable or comma-separated. Default: `claude`. |

```bash
skanvil init my-skills --scope acme --profile front,back
```

## `add`

Create a skill from a template and add it to the README index. If `--type`, `--name` or `--description` is missing, the missing values are prompted for in a terminal. In CI the command fails instead.

| Option                                           | Description                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `--type <category>`                              | Category id or alias from `.skanvilrc.json`.                                               |
| `--name <value>`                                 | Free-form name. It is kebab-cased and prefixed: `"API review"` becomes `front-api-review`. |
| `--title <value>`                                | Display title. Default: derived from the name.                                             |
| `--description <value>`                          | What the skill does and when to use it. A final period is added if missing.                |
| `--template <name>`                              | Use `.skanvil/templates/<name>` (see [Templates](templates.md)).                           |
| `--no-assets`, `--no-references`, `--no-scripts` | Do not create those folders.                                                               |
| `--skip-validate`                                | Do not validate the library afterwards.                                                    |

Afterwards the library is validated, and the exit code is 1 if errors remain. `--json` prints `{ skillName, title, type, target, template }` and skips validation.

## `edit <skill>`

Change or delete an existing skill. Provide at least one change.

| Option                  | Description                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--rename <value>`      | New base name. The category prefix is applied automatically.                                                 |
| `--type <category>`     | Move to another category: changes the prefix and README section, and updates `metadata` and `compatibility`. |
| `--title <value>`       | New `# heading` and README title.                                                                            |
| `--description <value>` | New frontmatter description and README description.                                                          |
| `--owner <value>`       | Set `metadata.owner`.                                                                                        |
| `--status <value>`      | Set `metadata.status` (`draft`, `experimental`, `active` or `deprecated`).                                   |
| `--replaced-by <skill>` | Set `metadata.replaced-by` (implies `--status deprecated`).                                                  |
| `--remove`              | Delete the skill folder and its README entry.                                                                |
| `--yes`                 | Do not ask for confirmation before `--remove`. Required in CI.                                               |
| `--skip-validate`       | Do not validate afterwards.                                                                                  |

```bash
skanvil edit front-api-review --rename http-review --type back
skanvil edit front-legacy --status deprecated --replaced-by front-modern
skanvil edit back-http-review --remove --yes
```

## `list`

Print a table of every skill folder.

| Column        | Meaning                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `SKILL`       | Folder name.                                                                                            |
| `TYPE`        | Category id.                                                                                            |
| `IN README`   | `yes`, `NO`, or `-` for categories that are not indexed.                                                |
| `VALID`       | `yes` (no errors), `NO`, or `-` for categories that are not validated.                                  |
| `STATUS`      | Shown when any skill sets `metadata.status`.                                                            |
| `OWNER`       | Shown when any skill sets `metadata.owner`.                                                             |
| `DESCRIPTION` | Frontmatter description (prefixed for deprecated skills with replacement), truncated to terminal width. |

| Option            | Description                                  |
| ----------------- | -------------------------------------------- |
| `--category <id>` | Only list one category.                      |
| `--status <val>`  | Only list skills matching `metadata.status`. |
| `--owner <val>`   | Only list skills matching `metadata.owner`.  |

With `--json`, it prints an array of `{ name, type, indexed, valid, status?, owner?, replacedBy?, description }`.

```bash
skanvil list --status deprecated
skanvil list --owner "@frontend-platform" --json
```

## `validate`

Run every [validation rule](validation.md).

| Option              | Description                                                                     |
| ------------------- | ------------------------------------------------------------------------------- |
| `--strict`          | Warnings also make the command fail.                                            |
| `--skill <name>`    | Only report problems of one skill.                                              |
| `--format <format>` | Output format: `text` (default), `github` (PR annotations), `sarif`, or `json`. |

Exit code 1 means there are errors, or warnings with `--strict`. `skanvil validate --help` lists every rule with its default severity. `--json` (or `--format json`) prints:

```json
{
  "ok": false,
  "diagnostics": [
    {
      "rule": "placeholders",
      "severity": "error",
      "skill": "front-x",
      "message": "contains a forbidden placeholder (\"TODO\")",
      "file": "skills/front-x/SKILL.md",
      "line": 14
    }
  ],
  "count": 3,
  "errors": 1,
  "warnings": 0
}
```

## `diff [baseRef]`

Compare the working library against a Git ref (`HEAD` by default) to inspect changed skills, Stage-1 `alwaysLoadedTokens` deltas, `params.json` schema changes, newly introduced validation diagnostics, and trigger routing regressions. Works whether the library is at the Git root or in a monorepo subdirectory.

| Option              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `--format <format>` | Output format: `text` (default) or `markdown`. |

```bash
skanvil diff
skanvil diff origin/main --format markdown > pr-comment.md
skanvil diff HEAD~1 --json
```

## `import <sourceDir>`

Bulk-import existing skill folders (such as `.claude/skills/` or `.cursor/skills/`) or a single skill directory containing `SKILL.md` into the library.

- Strips/applies the `--type` category prefix cleanly, aligns frontmatter `name`, converts legacy `tools` to `allowed-tools`, fills missing category `metadata`/`compatibility`, ensures a `# Title` heading, and excludes `.skanvil-sync.json`.
- Updates `README.md` and rolls back on failure. Existing skills are skipped unless `--overwrite` is passed.

| Option              | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `--type <category>` | Category id or alias from `.skanvilrc.json`.                      |
| `--skill <name>`    | Only import specific skill(s). Repeatable or comma-separated.     |
| `--dry-run`         | Preview imports and skipped collisions without writing.           |
| `--overwrite`       | Replace existing skill folders matching the resolved target name. |
| `--skip-validate`   | Skip post-import validation.                                      |

```bash
skanvil import ../app/.claude/skills --type front --dry-run
skanvil import ../legacy-skill --type back --overwrite
```

## `index`

Regenerate the README index from the skill folders. Rules:

- Each indexed category's `<details>` block is rewritten.
- Existing entries keep their position and title.
- New skills are appended alphabetically.
- Descriptions are taken from the frontmatter.

| Option    | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| `--check` | Do not write. Exit 1 if the README is out of date. Use it in CI. |

## `doctor`

Without options, `doctor` lists the problems and marks the ones it can fix automatically.

With `--fix` it:

- adds missing README entries, removes orphan ones and moves misplaced ones;
- sets `name` to the folder name;
- replaces tabs in the frontmatter;
- converts `tools` to `allowed-tools`.

Pass `--scaffold-sections` alongside `--fix` to insert minimal stubs (including the `## Error Recovery` Markdown table) for any missing sections from `validation.requiredSections`. Stubs keep a `template-unchanged` warning until you replace the generic row with real guidance.

| Option                | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| `--fix`               | Apply automatic repairs.                                                           |
| `--scaffold-sections` | Insert minimal stubs for missing `validation.requiredSections` (requires `--fix`). |

It then validates again and exits 1 if errors remain.

## `stats`

Report 3-stage context-budget metrics (`name` + `description`, `SKILL.md` body lines/tokens, and `references/` / `scripts/` / `assets/` resource counts) for validated skills. See [Evals and quality](evals-and-quality.md).

| Column      | Meaning                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| `SKILL`     | Folder name.                                                                           |
| `STAGE 1`   | Estimated always-loaded tokens (`name` + `description`).                               |
| `LINES`     | Total lines in `SKILL.md` (rendered with defaults for parametrized skills).            |
| `BODY TOK`  | Estimated tokens of the full `SKILL.md` file.                                          |
| `RESOURCES` | Non-hidden file count and estimated text tokens in `references/`/`scripts/`/`assets/`. |
| `UNUSED`    | Count of resource files never referenced from `SKILL.md`.                              |

| Option            | Description                                                |
| ----------------- | ---------------------------------------------------------- |
| `--category <id>` | Only include skills of this category.                      |
| `--skill <name>`  | Only inspect one skill.                                    |
| `--sort <key>`    | Sort order: `tokens`, `lines` or `name` (default: `name`). |

```bash
skanvil stats --sort tokens
skanvil stats --category front --json
```

`--json` prints:

```json
{
  "count": 1,
  "totals": {
    "alwaysLoadedTokens": 23,
    "bodyTokens": 523,
    "bodyLines": 52,
    "resourceFiles": 3,
    "resourceTokens": 218,
    "unreferencedFiles": 0
  },
  "skills": [
    {
      "name": "front-a11y",
      "category": "front",
      "alwaysLoaded": { "chars": 89, "estimatedTokens": 23 },
      "body": { "lines": 52, "chars": 2092, "estimatedTokens": 523 },
      "resources": { "files": 3, "chars": 872, "estimatedTokens": 218, "unreferencedFiles": [] },
      "totalEstimatedTokens": 741
    }
  ]
}
```

## `eval triggers`

Evaluate `shouldTrigger` and `shouldNotTrigger` prompts declared in each skill's `evals.json` offline against the library's skill descriptions using BM25 lexical scoring.

| Option           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `--skill <name>` | Only check triggers belonging to one skill.    |
| `--split <tag>`  | Only check prompts tagged `train` or `eval`.   |
| `--strict`       | Exit with code 1 when any trigger check fails. |

```bash
skanvil eval triggers
skanvil eval triggers --split eval --strict --json
```

`--json` prints `{ ok, total, passed, failed, bySplit, results }`.

## `eval export`

Export `evals.json` cases and triggers as structured JSON or a Promptfoo configuration for external LLM evaluation and blind A/B ablation testing.

| Option              | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `--format <format>` | Output format: `json` (default) or `promptfoo`.         |
| `--ablation`        | Pair each case with a `without-skill` baseline variant. |
| `--skill <name>`    | Only export one skill.                                  |
| `--split <tag>`     | Only export items tagged `train` or `eval`.             |
| `--out <file>`      | Write the dataset to a file instead of stdout.          |

```bash
skanvil eval export --format json --ablation
skanvil eval export --format promptfoo --ablation --split eval --out evals.promptfoo.json
```

## `eval route <prompt>`

Simulate Stage-1 offline BM25 trigger routing for any free-form user prompt across all validated, non-deprecated skills in the library.

| Option      | Description                                               |
| ----------- | --------------------------------------------------------- |
| `--top <n>` | Maximum matching candidate skills to return (default: 5). |

```bash
skanvil eval route "Audit React modal keyboard focus" --top 3
skanvil eval route "Review Postgres migration locks" --json
```

## `feedback list`

Summarize and group friction reports recorded in `.skanvil-feedback.jsonl` (produced by the bundled `skanvil-feedback` skill), tolerating malformed lines without aborting.

| Option           | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `--file <path>`  | Feedback JSONL log path (default: `.skanvil-feedback.jsonl`). |
| `--skill <name>` | Only include entries for one skill.                           |

```bash
skanvil feedback list
skanvil feedback list --skill back-migrations --json
```

## `feedback promote`

Promote validated `suggestedEvalCase` entries from `.skanvil-feedback.jsonl` into target skill `evals.json` suites, avoiding duplicate IDs or prompts and verifying parameter overrides against `params.json`.

| Option           | Description                                                                      |
| ---------------- | -------------------------------------------------------------------------------- |
| `--file <path>`  | Feedback JSONL log path (default: `.skanvil-feedback.jsonl`).                    |
| `--skill <name>` | Only promote entries for one skill.                                              |
| `--dry-run`      | Preview promotions without editing `evals.json` or the JSONL log.                |
| `--prune`        | Remove promoted lines from the log while keeping skipped/invalid entries intact. |

```bash
skanvil feedback promote --dry-run
skanvil feedback promote --prune --json
```

## `feedback push`

Upload sanitized friction reports from `.skanvil-feedback.jsonl` to a self-hosted `skanvil-hub` instance. Credential patterns and personal home directory paths are redacted locally, and each event receives a deterministic `fb_<hash>` ID so retries stay idempotent. See [Telemetry and hub](telemetry-and-hub.md).

| Option             | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `--file <path>`    | Feedback JSONL log path (default: `.skanvil-feedback.jsonl`).        |
| `--skill <name>`   | Only push entries for one skill.                                     |
| `--endpoint <url>` | `skanvil-hub` base URL (default: `SKANVIL_TELEMETRY_URL` or config). |
| `--api-key <key>`  | Bearer ingestion key (default: `SKANVIL_TELEMETRY_KEY`).             |
| `--dry-run`        | Build redacted events without sending or queueing.                   |
| `--no-queue`       | Fail immediately instead of buffering to the local offline queue.    |

```bash
skanvil feedback push --dry-run
skanvil feedback push --endpoint https://skanvil-hub.internal --json
```

`--json` prints `{ file, invalidLines, sent, queued, dryRun, skippedReason?, error?, events }`.

## `telemetry snapshot`

Collect Stage-1/2/3 token budgets, validation error/warning counts, offline eval trigger pass rates, and per-skill lifecycle metadata, and send a `library.snapshot` event to `skanvil-hub`.

| Option             | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `--endpoint <url>` | `skanvil-hub` base URL (default: `SKANVIL_TELEMETRY_URL` or config). |
| `--api-key <key>`  | Bearer ingestion key (default: `SKANVIL_TELEMETRY_KEY`).             |
| `--dry-run`        | Build and inspect the snapshot without sending or queueing.          |
| `--no-queue`       | Exit with code 1 instead of buffering locally if delivery fails.     |

```bash
skanvil telemetry snapshot --dry-run --json
skanvil telemetry snapshot --no-queue
```

`--json` prints `{ sent, queued, dryRun, skippedReason?, error?, events }`.

## `telemetry emit`

Manually emit a `skill.invoked` usage event from scripts, CI pipelines, or agent workflows.

| Option                    | Description                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `--skill <name>`          | Skill folder name (required).                                        |
| `--library <name>`        | Owning library identifier (default: config name or `"local"`).       |
| `--agent <name>`          | Agent name (`claude`, `cursor`, `gemini`, etc.).                     |
| `--model <name>`          | Model identifier.                                                    |
| `--outcome <value>`       | `success` (default), `error`, `friction`, or `unknown`.              |
| `--duration-ms <n>`       | Execution duration in milliseconds (non-negative integer).           |
| `--tool-calls <n>`        | Total tool calls (non-negative integer).                             |
| `--failed-tool-calls <n>` | Failed tool calls (non-negative integer).                            |
| `--endpoint <url>`        | `skanvil-hub` base URL (default: `SKANVIL_TELEMETRY_URL` or config). |
| `--api-key <key>`         | Bearer ingestion key (default: `SKANVIL_TELEMETRY_KEY`).             |
| `--dry-run`               | Build the event without sending.                                     |
| `--no-queue`              | Fail instead of buffering to the offline queue on network errors.    |

```bash
skanvil telemetry emit --skill front-api-review --agent claude --outcome success --duration-ms 1250
```

`--json` prints `{ sent, queued, dryRun, skippedReason?, error?, events }`.

## `telemetry hook`

Read an agent hook JSON payload on `stdin` (`PostToolUse`, `afterFileRead`, `AfterTool`), extract skill invocation metadata when a skill's `SKILL.md` is read or a `Skill` tool runs, and send or queue a `skill.invoked` event. Always exits `0` silently so coding agents are never blocked.

| Option             | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `--agent <name>`   | Hook source: `claude`, `cursor`, or `gemini` (required).             |
| `--endpoint <url>` | `skanvil-hub` base URL (default: `SKANVIL_TELEMETRY_URL` or config). |
| `--api-key <key>`  | Bearer ingestion key (default: `SKANVIL_TELEMETRY_KEY`).             |

## `telemetry push`

Flush previously queued offline telemetry events from `~/.skanvil/telemetry-queue.jsonl` (or `SKANVIL_TELEMETRY_QUEUE`) to `skanvil-hub`, removing delivered events cleanly.

| Option             | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `--endpoint <url>` | `skanvil-hub` base URL (default: `SKANVIL_TELEMETRY_URL` or config). |
| `--api-key <key>`  | Bearer ingestion key (default: `SKANVIL_TELEMETRY_KEY`).             |
| `--dry-run`        | Count queued events without sending or modifying the queue file.     |

`--json` prints `{ sent, queued, remaining, invalidLines, dryRun, skippedReason?, error?, events }`.

## `telemetry install-hooks [dest]`

Idempotently install non-blocking telemetry hooks into `claude` (`.claude/settings.json`), `cursor` (`.cursor/hooks.json`), and/or `gemini` (`.gemini/settings.json`) settings without overwriting unrelated user rules.

| Option            | Description                                                                   |
| ----------------- | ----------------------------------------------------------------------------- |
| `--target <name>` | `claude`, `cursor`, `gemini` (repeatable or comma-separated; default: all 3). |
| `--global`        | Write into user home config folders instead of a project (`dest` disallowed). |
| `--dry-run`       | Preview settings changes without writing.                                     |

```bash
skanvil telemetry install-hooks --target claude,cursor,gemini --dry-run
skanvil telemetry install-hooks --global --target claude
```

`--json` prints `{ dryRun, scope, results: [{ agent, file, status }] }`.

## `templates eject`

Copy the built-in skill template into the library so you can edit it.

| Option            | Description                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `--category <id>` | Eject to `skill-<id>`, used only for that category. Default: `skill`, used for all categories. |
| `--force`         | Overwrite an existing folder.                                                                  |

## `sync [dest]`

Install the library's skills into a project. `dest` defaults to the current directory. See [Sync](sync.md).

| Option                    | Description                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target <name>`         | `claude`, `copilot`, `agents`, `codex`, `cursor`, `opencode`, `windsurf`, `gemini`, or a path relative to `dest`. Repeatable and comma-separated. Default: `sync.targets` from the config, or `claude`. |
| `--from <pkg\|path\|git>` | Source library: a folder, an installed npm package in `node_modules`, or a Git URL (`github:org/repo[#ref]`, `git+https://...`, `git@...`). Default: `--cwd`.                                           |
| `--link`                  | Symlink instead of copying (junctions on Windows; falls back to copy for temporary Git sources).                                                                                                        |
| `--copy`                  | Copy, even if the config sets `sync.mode: "link"`.                                                                                                                                                      |
| `--category <id>`         | Only sync this category. Repeatable. Disables pruning.                                                                                                                                                  |
| `--skill <name>`          | Only sync this skill. Repeatable. Disables pruning.                                                                                                                                                     |
| `--status <value>`        | Only sync skills with this `metadata.status`. Repeatable. Disables pruning.                                                                                                                             |
| `--include-deprecated`    | Also sync skills marked `metadata.status: "deprecated"` (skipped and pruned by default).                                                                                                                |
| `--force`                 | Also sync skills that have validation errors.                                                                                                                                                           |
| `--dry-run`               | Show what would change without writing.                                                                                                                                                                 |
| `--param <name=value>`    | Value for [parametrized skills](params-and-exports.md). Repeatable. It applies to every synced skill that declares it, and an unknown name is an error. Remembered per target and source.               |
| `--global`                | Install into your user folders instead of a project (see below). Do not pass `dest` with it.                                                                                                            |

Custom `--target` paths must resolve to a folder inside `dest`: `../shared` or `.` are rejected before anything is written. With `--global`, only presets are accepted:

- `claude` → `~/.claude/skills`
- `copilot` → `~/.copilot/skills`
- `agents` / `codex` → `~/.agents/skills`
- `cursor` → `~/.cursor/skills`
- `opencode` → `~/.config/opencode/skills`
- `windsurf` → `~/.codeium/windsurf/skills`
- `gemini` → `~/.gemini/skills`

```bash
skanvil sync ../my-app --target claude,cursor --dry-run
skanvil sync --from @acme/my-skills --target agents --link
skanvil sync --from github:acme/my-skills#v1 --target claude
skanvil sync -C ./my-skills --global --target claude,gemini
```

## `build`

Generate the library's npm exports in `dist/`: `index.mjs`, `index.cjs` and their type declarations. They contain one function per publishable skill that returns its `SKILL.md` (rendered with parameters), a `skills` list and `getSkill(name)`. See [Parameters and exports](params-and-exports.md).

| Option        | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `--out <dir>` | Output folder relative to the library root. Default: `dist`. |
| `--force`     | Build even when validation reports errors.                   |

`--json` prints `{ outDir, files, skills: [{ name, exportName, category, params }] }`.

## `install-skill [dest]`

Install or update the `skanvil` and `skanvil-feedback` agent skills in a project, so coding agents there know how to use skanvil, fix diagnostics, and log skill friction reports. `dest` defaults to the current directory.

| Option            | Description                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target <name>` | `claude`, `copilot`, `agents`, `codex`, `cursor`, `opencode`, `windsurf`, `gemini`, or a path relative to `dest`. Repeatable and comma-separated. Default: `claude`. |
| `--force`         | Replace a `skanvil` or `skanvil-feedback` folder that skanvil did not install, or reinstall the same version.                                                        |
| `--global`        | Install into your user folders (`~/.claude/skills`, `~/.cursor/skills`, …) so every project gets it. Presets only; no `dest`.                                        |
| `--no-feedback`   | Do not install `skanvil-feedback` alongside `skanvil`.                                                                                                               |

Installed copies carry `metadata.skanvil-version`. Run the command again after upgrading skanvil to refresh them. It exits with 1 if any target was skipped because it holds a foreign folder.

```bash
skanvil install-skill --target claude,copilot
skanvil install-skill ../my-app --target agents --no-feedback --json
skanvil install-skill --global --target claude,copilot
```
