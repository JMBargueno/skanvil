# Sync: installing skills into projects

Coding agents discover skills in well-known folders of the repository they work in. `skanvil sync` copies (or links) the skills of a library into those folders, and keeps them up to date over time.

```bash
skanvil sync [dest] [--target …] [--from …] [--link] [--dry-run]
```

`dest` is the project root (default: the current directory). The source library is `--cwd`, or `--from`.

## Targets

| Preset    | Folder           | Read by                                             |
| --------- | ---------------- | --------------------------------------------------- |
| `claude`  | `.claude/skills` | Claude Code, and GitHub Copilot                     |
| `copilot` | `.github/skills` | GitHub Copilot (VS Code, Copilot CLI, coding agent) |
| `agents`  | `.agents/skills` | OpenAI Codex, and GitHub Copilot                    |
| `codex`   | `.agents/skills` | Alias of `agents`                                   |

Any other value is treated as a path relative to `dest`, for example `--target tools/agent-skills`. Custom paths must stay inside `dest`: `..`, absolute paths that point elsewhere, and `dest` itself are rejected. All targets are checked before anything is written.

Targets are taken from the first source that provides any:

1. `--target` (repeatable, comma-separated allowed);
2. `sync.targets` in the library's `.skanvilrc.json`;
3. `claude`.

## User-level installation (`--global`)

Agents also read skills from your home folder, and those skills are available in every project. `--global` installs there instead of into a project:

| Preset             | Folder              |
| ------------------ | ------------------- |
| `claude`           | `~/.claude/skills`  |
| `copilot`          | `~/.copilot/skills` |
| `agents` / `codex` | `~/.agents/skills`  |

```bash
skanvil sync -C ./my-skills --global --target claude,copilot
skanvil install-skill --global --target claude
```

How it differs from a project install:

- Only presets are accepted, and no `dest` argument.
- The manifest, pruning and foreign-folder protection work exactly as in a project.
- Personal skills in `~/.copilot/skills` are not guaranteed to reach GitHub's cloud agent sessions. Commit skills to the repository when cloud agents need them.

## Source

```bash
skanvil sync ../my-app -C ./my-skills                    # a local library
skanvil sync --from ../my-skills                         # same, from the project's side
skanvil sync --from @acme/my-skills --target copilot     # an installed npm package
```

`--from` first tries a folder path relative to `dest`. Otherwise it looks for `node_modules/<package>` in `dest` and its parent folders.

## What gets synced

- Only categories with `validated: true`. The default `_internal` skills are never published: their names are not valid under the spec and they are meant for the library itself.
- Skills with validation errors are skipped, with a message, unless `--force` is given. README-only problems do not block a skill.
- `--category` and `--skill` restrict the selection. Both are repeatable.

## Parameters

Skills with a `params.json` are installed rendered: `--param name=value` sets values, and defaults fill the rest. The values are remembered per target, so later syncs reuse them. See [Parameters and exports](params-and-exports.md).

## Copy or link

| Mode           | How                                                                                     | When to use                                                                 |
| -------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| copy (default) | Files are copied.                                                                       | Commit the skills into the project; works everywhere.                       |
| `--link`       | Directory symlinks, or junctions on Windows (no admin rights or Developer Mode needed). | Local development: edits in the library show up in the project immediately. |

If creating a link fails, skanvil warns and copies instead. Set the default with `sync.mode` in the config. `--copy` overrides a config default of `link`.

## Idempotency and safety

Each target folder gets a `.skanvil-sync.json` manifest. It records:

- the skills skanvil installed;
- a content hash of each one;
- the mode used;
- the source path, relative to the target so the file does not change between machines.

On every run:

- **Unchanged** skills (same hash and mode) are left alone.
- **Changed** skills are replaced.
- **Removed** skills, meaning installed earlier but deleted from the library since, are deleted from the target.
  - Pruning is disabled when `--category` or `--skill` is used, so a partial sync never deletes the rest.
  - A skill that is temporarily failing validation keeps its last good copy.
- **Foreign** skills are never touched. A folder that exists in the target but is not in the manifest is skipped with a warning, even when it has the same name as a library skill.

Use `--dry-run` to see the plan without writing anything:

```text
[sync] (dry run) claude -> /work/my-app/.claude/skills: 1 added, 1 updated, 4 unchanged, 1 removed
   + front-a11y
   ~ back-migrations
   - back-legacy-orm
```

`--json` prints `{ dryRun, mode, results: [{ target, path, added, updated, unchanged, removed, skipped, warnings }] }`.

## Committing synced skills

Committing the copied skills to the application repository is the most portable option: every developer and every cloud agent gets them without running skanvil. Commit `.skanvil-sync.json` too, so the next sync can prune correctly.

To keep them in sync automatically, add a script to the application:

```json
{
  "scripts": {
    "skills:sync": "skanvil sync --from @acme/my-skills --target claude,copilot"
  }
}
```

Run it after upgrading the library package, or in a scheduled CI job that opens a pull request.
