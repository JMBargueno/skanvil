# Command reference

```text
skanvil <command> [options]
```

**Global options:**

- `-h, --help` shows help.
- `--version` prints the version.
- Running `skanvil` without a command opens the [wizard](#wizard) in an interactive terminal. In CI or a pipe it prints the help and exits with code 1.

**Common options:**

| Option             | Description                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-C, --cwd <path>` | Library root. Default: the current directory. For `sync`, this is the _source_ library. Every command except `wizard` and `install-skill` accepts it. |
| `--json`           | Print machine-readable JSON on stdout. Informational text is suppressed; warnings and errors still go to stderr.                                      |

**Exit codes:**

- `0`: success.
- `1`: any error, such as invalid arguments, validation errors, or a failed check or operation. Errors are printed as `skanvil: <message>`.

---

## `wizard`

An interactive assistant. `skanvil` runs it when called with no arguments in a terminal, and `skanvil wizard` starts it explicitly. It needs a TTY: without one it fails with exit code 1.

The menu depends on the current folder:

| Where             | Actions                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outside a library | Create a library (default preset, your own categories, or no categories); install skills from a library into this folder; install the agent skill.                                    |
| Inside a library  | Add a skill; edit, rename, move or delete one; list skills; check the library and apply automatic fixes; install the skills into a project or for your user; install the agent skill. |

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
| `--remove`              | Delete the skill folder and its README entry.                                                                |
| `--yes`                 | Do not ask for confirmation before `--remove`. Required in CI.                                               |
| `--skip-validate`       | Do not validate afterwards.                                                                                  |

```bash
skanvil edit front-api-review --rename http-review --type back
skanvil edit back-http-review --remove --yes
```

## `list`

Print a table of every skill folder.

| Column        | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `SKILL`       | Folder name.                                                           |
| `TYPE`        | Category id.                                                           |
| `IN README`   | `yes`, `NO`, or `-` for categories that are not indexed.               |
| `VALID`       | `yes` (no errors), `NO`, or `-` for categories that are not validated. |
| `DESCRIPTION` | Frontmatter description, truncated to the terminal width.              |

| Option            | Description             |
| ----------------- | ----------------------- |
| `--category <id>` | Only list one category. |

With `--json`, it prints an array of `{ name, type, indexed, valid, description }`.

## `validate`

Run every [validation rule](validation.md).

| Option           | Description                          |
| ---------------- | ------------------------------------ |
| `--strict`       | Warnings also make the command fail. |
| `--skill <name>` | Only report problems of one skill.   |

Exit code 1 means there are errors, or warnings with `--strict`. `skanvil validate --help` lists every rule with its default severity. `--json` prints:

```json
{
  "ok": false,
  "diagnostics": [{ "rule": "placeholders", "severity": "error", "skill": "front-x", "message": "…" }],
  "count": 3,
  "errors": 1,
  "warnings": 0
}
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

It then validates again and exits 1 if errors remain.

## `templates eject`

Copy the built-in skill template into the library so you can edit it.

| Option            | Description                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `--category <id>` | Eject to `skill-<id>`, used only for that category. Default: `skill`, used for all categories. |
| `--force`         | Overwrite an existing folder.                                                                  |

## `sync [dest]`

Install the library's skills into a project. `dest` defaults to the current directory. See [Sync](sync.md).

| Option               | Description                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target <name>`    | `claude`, `copilot`, `agents`, `codex`, or a path relative to `dest`. Repeatable and comma-separated. Default: `sync.targets` from the config, or `claude`. |
| `--from <pkg\|path>` | Source library: a folder, or an npm package installed in a `node_modules` above `dest`. Default: `--cwd`.                                                   |
| `--link`             | Symlink instead of copying (junctions on Windows).                                                                                                          |
| `--copy`             | Copy, even if the config sets `sync.mode: "link"`.                                                                                                          |
| `--category <id>`    | Only sync this category. Repeatable. Disables pruning.                                                                                                      |
| `--skill <name>`     | Only sync this skill. Repeatable. Disables pruning.                                                                                                         |
| `--force`            | Also sync skills that have validation errors.                                                                                                               |
| `--dry-run`          | Show what would change without writing.                                                                                                                     |
| `--global`           | Install into your user folders instead of a project (see below). Do not pass `dest` with it.                                                                |

Custom `--target` paths must resolve to a folder inside `dest`: `../shared` or `.` are rejected before anything is written. With `--global`, only presets are accepted:

- `claude` installs into `~/.claude/skills`;
- `copilot` installs into `~/.copilot/skills`;
- `agents` and `codex` install into `~/.agents/skills`.

```bash
skanvil sync ../my-app --target claude,copilot --dry-run
skanvil sync --from @acme/my-skills --target agents --link
skanvil sync -C ./my-skills --global --target claude
```

## `install-skill [dest]`

Install or update the `skanvil` agent skill in a project, so coding agents there know how to use skanvil: which commands to run, the golden rules, and how to fix each diagnostic. `dest` defaults to the current directory.

| Option            | Description                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--target <name>` | `claude`, `copilot`, `agents`, `codex`, or a path relative to `dest`. Repeatable and comma-separated. Default: `claude`. |
| `--force`         | Replace a `skanvil` folder that skanvil did not install, or reinstall the same version.                                  |
| `--global`        | Install into your user folders (`~/.claude/skills`, …) so every project gets it. Presets only; no `dest`.                |

Installed copies carry `metadata.skanvil-version`. Run the command again after upgrading skanvil to refresh them. It exits with 1 if any target was skipped because it holds a foreign `skanvil` folder.

```bash
skanvil install-skill --target claude,copilot
skanvil install-skill ../my-app --target agents --json
skanvil install-skill --global --target claude,copilot
```
