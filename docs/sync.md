# Sync: installing skills into projects

Coding agents discover skills in well-known folders of the repository they work in. `skanvil sync` copies (or links) the skills of a library into those folders, and keeps them up to date over time.

```bash
skanvil sync [dest] [--target …] [--from …] [--link] [--dry-run]
```

`dest` is the project root (default: the current directory). The source library is `--cwd`, or `--from`.

## Targets

| Preset     | Folder             | Read by                                             |
| ---------- | ------------------ | --------------------------------------------------- |
| `claude`   | `.claude/skills`   | Claude Code, and GitHub Copilot                     |
| `copilot`  | `.github/skills`   | GitHub Copilot (VS Code, Copilot CLI, coding agent) |
| `agents`   | `.agents/skills`   | OpenAI Codex, and GitHub Copilot                    |
| `codex`    | `.agents/skills`   | Alias of `agents`                                   |
| `cursor`   | `.cursor/skills`   | Cursor                                              |
| `opencode` | `.opencode/skills` | OpenCode                                            |
| `windsurf` | `.windsurf/skills` | Windsurf                                            |
| `gemini`   | `.gemini/skills`   | Gemini CLI                                          |

Any other value is treated as a path relative to `dest`, for example `--target tools/agent-skills`. Custom paths must stay inside `dest`: `..`, absolute paths that point elsewhere, and `dest` itself are rejected. All targets are checked before anything is written.

Targets are taken from the first source that provides any:

1. `--target` (repeatable, comma-separated allowed);
2. `sync.targets` in the library's `.skanvilrc.json`;
3. `claude`.

## User-level installation (`--global`)

Agents also read skills from your home folder, and those skills are available in every project. `--global` installs there instead of into a project:

| Preset             | Folder                       |
| ------------------ | ---------------------------- |
| `claude`           | `~/.claude/skills`           |
| `copilot`          | `~/.copilot/skills`          |
| `agents` / `codex` | `~/.agents/skills`           |
| `cursor`           | `~/.cursor/skills`           |
| `opencode`         | `~/.config/opencode/skills`  |
| `windsurf`         | `~/.codeium/windsurf/skills` |
| `gemini`           | `~/.gemini/skills`           |

```bash
skanvil sync -C ./my-skills --global --target claude,cursor,gemini
skanvil install-skill --global --target claude
```

How it differs from a project install:

- Only presets are accepted, and no `dest` argument.
- The manifest, pruning and foreign-folder protection work exactly as in a project.
- Personal skills in `~/.copilot/skills` are not guaranteed to reach GitHub's cloud agent sessions. Commit skills to the repository when cloud agents need them.

## Source (`--from`)

```bash
skanvil sync ../my-app -C ./my-skills                            # a local library
skanvil sync --from ../my-skills                                 # same, from the project's side
skanvil sync --from @acme/my-skills --target copilot             # an installed npm package
skanvil sync --from github:acme/my-skills#v1 --target claude     # GitHub shorthand + tag/branch
skanvil sync --from git+https://example.com/team/skills.git      # explicit Git URL
```

`--from` supports:

1. **Git URLs / shorthands:** `github:owner/repo[#ref]`, `git+https://...[#ref]`, `https://...git[#ref]`, and `git@host:owner/repo[#ref]`. skanvil shallow-clones (`--depth 1`) to a temporary folder cleaned up automatically after syncing, records the canonical Git specifier in `.skanvil-sync.json`, and automatically falls back to `copy` (with a warning) if `--link` was requested.
2. **Local directories:** relative to `dest`.
3. **Installed npm packages:** looks for `node_modules/<package>` in `dest` and its parent folders.

## What gets synced

- Only categories with `validated: true`. The default `_internal` skills are never published: their names are not valid under the spec and they are meant for the library itself.
- Skills with `metadata.status: "deprecated"` are skipped by default (reporting any `metadata.replaced-by` replacement) and pruned from targets when no filter is active. Pass `--include-deprecated` or `--status deprecated` to include them.
- Skills with validation errors are skipped, with a message, unless `--force` is given. README-only problems do not block a skill.
- `--category`, `--skill` and `--status` restrict the selection. All three are repeatable and disable pruning.
- Authoring metadata files `params.json` and `evals.json` are excluded from copied targets so they never add context overhead in consumer projects.

## Parameters

Skills with a `params.json` are installed rendered: `--param name=value` sets values, and defaults fill the rest. The values are remembered per target, so later syncs reuse them. See [Parameters and exports](params-and-exports.md).

## Copy or link

| Mode           | How                                                                                     | When to use                                                                 |
| -------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| copy (default) | Files are copied.                                                                       | Commit the skills into the project; works everywhere.                       |
| `--link`       | Directory symlinks, or junctions on Windows (no admin rights or Developer Mode needed). | Local development: edits in the library show up in the project immediately. |

If creating a link fails, skanvil warns and copies instead. Set the default with `sync.mode` in the config. `--copy` overrides a config default of `link`.

## Idempotency, multi-library support & safety

Each target folder holds a `.skanvil-sync.json` manifest (Manifest v2, reading and automatically upgrading legacy v1 manifests in place). It records a `sources` map keyed by library path or canonical Git specifier, storing for each coexisting library:

- the skills owned by that library source;
- a content hash and installation mode (`copy` or `link`) per skill;
- remembered `--param` values for that source.

On every run:

- **Unchanged** skills from this source (same hash and mode) are left alone.
- **Changed** skills from this source are replaced.
- **Removed** skills from **this** library, meaning installed earlier from the same source and now deleted or marked `deprecated`, are removed from the target without touching skills installed by other libraries.
  - Pruning is disabled when `--category`, `--skill` or `--status` is used, so a partial sync never deletes the rest.
  - A skill that is temporarily failing validation keeps its last good copy.
- **Foreign & colliding** skills are never touched. A folder not in the manifest, or already managed by another library source in `.skanvil-sync.json`, is skipped with a clear warning even if it shares the same name.
- **`alwaysLoadedTokens`** reports the combined Stage-1 token footprint of every active skill across all coexisting sources in that target folder.

Use `--dry-run` to see the plan without writing anything:

```text
[sync] (dry run) claude -> /work/my-app/.claude/skills: 1 added, 1 updated, 4 unchanged, 1 removed (~420 always-loaded tokens)
   + front-a11y
   ~ back-migrations
   - back-legacy-orm
```

`--json` prints `{ dryRun, mode, results: [{ target, path, added, updated, unchanged, removed, skipped, warnings, params, alwaysLoadedTokens }] }`.

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
