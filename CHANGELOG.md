# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - Unreleased

First public release.

### Added

- **CLI commands**:
  - `init`, `add`, `edit`, `list`, `validate`, `index`, `doctor`, `templates eject`, `sync` and `install-skill`;
  - an interactive wizard (`skanvil` without arguments in a terminal, or `skanvil wizard`) that creates libraries, including with custom categories, and manages and installs skills. Installs show a preview, and every action prints its equivalent command;
  - every command accepts `--json`, and every library command accepts `--cwd`.
- **Configurable categories** in `.skanvilrc.json`: prefixes, README titles, aliases, metadata, and `indexed`/`validated` flags. Also config sections for `validation`, `templates` and `sync`. A JSON Schema is published as `skanvil/schema.json`.
- **Validation** against the Agent Skills spec and library conventions, with per-rule severities (`error`, `warn`, `off`), `--strict` and JSON output. It also checks that files referenced from `SKILL.md` exist (`broken-references`) and warns while scaffolded template text is still present (`template-unchanged`).
- **YAML-aware editing** of `SKILL.md`: comments, quoting, multi-line values and CRLF line endings are preserved.
- **Transactional `edit`**, which rolls back if the folder rename fails.
- **README index maintenance**: `index [--check]` regenerates or verifies it, and `doctor --fix` repairs drift.
- **Custom templates**, resolved per category, then per library, then built-in.
- **`sync`**: installs skills into `.claude/skills`, `.github/skills`, `.agents/skills` or any path, by copy or link (junctions on Windows), with a manifest, pruning, `--dry-run` and `--from <package>`. Custom target paths cannot leave the project. `--global` installs into the user's folders (`~/.claude/skills`, `~/.copilot/skills`, `~/.agents/skills`).
- **The `skanvil` agent skill**, which teaches coding agents how to use the tool. `init` installs it into new libraries, and `install-skill` installs it into any project or, with `--global`, for the user.
- **Programmatic API**: `import { Library, scaffoldSkill, validateLibrary, syncSkills } from "skanvil"`, fully typed and documented.
- **Generated libraries** include a GitHub Actions workflow and an `npm test` script (`validate --strict && index --check`).
