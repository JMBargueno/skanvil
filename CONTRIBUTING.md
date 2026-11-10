# Contributing

## Setup

```bash
git clone https://github.com/JMBargueno/skanvil.git && cd skanvil
npm install
npm test
```

You need Node.js 20 or later. Development and CI use the same versions.

## Scripts

| Script                               | Purpose                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `npm run dev -- <command> [options]` | Run the CLI from source with tsx, e.g. `npm run dev -- list -C ../my-skills`. |
| `npm run typecheck`                  | `tsc --noEmit` over `src/` and `tests/`.                                      |
| `npm run lint`                       | ESLint (typescript-eslint recommended rules).                                 |
| `npm run format` / `format:check`    | Prettier: write, or check only (CI).                                          |
| `npm test`                           | vitest, once. `npm run test:watch` for watch mode.                            |
| `npm run build`                      | tsup bundle into `dist/`, then `schema.json` from the zod schema.             |

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, build and tests on Linux and Windows with Node 20, 22 and 24. Run the same commands locally before opening a pull request.

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md). In short:

- `src/core/` holds all behaviour and never prints.
- `src/commands/` turns CLI options into core calls and output.
- `src/cli.ts` declares the commands.
- `templates/` is data.

## Tests

- **`tests/core.test.ts`** has unit tests for pure modules: naming, config, `SkillFile`, the README index and placeholders.
- **`tests/commands.test.ts`** has end-to-end tests of the core operations on temporary libraries created with `createLibrary` (`init`, `add`, `edit`, validation, `list`, index, `doctor`, templates, sync, agent skill).
- **`tests/cli.test.ts`** runs the real CLI as a child process without a TTY and checks exit codes, text and `--json` output. `tests/setup/build-cli.ts` bundles it into `tmp/cli-build` before the run, so `dist/` is never touched.

Every behaviour change needs a test. Prefer asserting on files written to disk over asserting on internals.

## Conventions

- TypeScript strict mode, ESM, `node:` imports, no default exports.
- **JSDoc on every exported symbol:** a summary sentence, plus `@param`, `@returns` and `@throws`, and `@example` for public entry points. The comments end up in `dist/index.d.ts`, so treat them as user documentation.
- **Core functions:** take a `Library` (or a `LibraryRef`), return data, throw `Error` with a message a user can act on.
- **Commands:** return an exit code, support `--json`, and print through `Output`.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). They decide the next version; see [Releases](#releases).

## Common changes

### Add a validation rule

1. Add an entry to `RULES` in `src/core/validate.ts`, with an id, default severity, description and, if repairable, `fixable: true`.
2. Report it with `collector.add(ruleId, message, skill)`, in `validateSkillFile` for per-skill rules or in `validateLibrary` for library-wide ones.
3. If it is fixable, implement the fix in `src/core/doctor.ts`.
4. Add a test, and add the rule to the table in [docs/validation.md](docs/validation.md).

### Add a command

1. Implement the behaviour in `src/core/` and export it from `src/index.ts` if it is useful as API.
2. Add a handler in `src/commands/` that returns an exit code.
3. Register it in `buildProgram()` in `src/cli.ts`, with `cwdOption()` and `jsonOption()`.
4. Document it in [docs/commands.md](docs/commands.md), the README table and the agent skill (`agent-skill/skanvil/`).

### Add a sync target preset

Add it to `TARGET_PRESETS` in `src/core/sync.ts`, with a comment naming the agent, after checking that agent's documentation for the project-level skills folder. Then update [docs/sync.md](docs/sync.md).

### Keep the agent skill up to date

`agent-skill/skanvil/` is how coding agents learn to use skanvil. Update it whenever you change user-facing behaviour:

- `SKILL.md`: golden rules, task recipes and the diagnostic → fix table;
- `references/REFERENCE.md`: options, config schema and JSON shapes.

The test `the bundled skill passes skanvil's own default validation` must stay green. In particular, the skill must not contain any default placeholder string, even as an example.

### Change the default skill or library template

Edit `templates/skill/` or `templates/library/`.

- Keep the required sections.
- Leave no placeholder text.
- Remember that `templates/library/gitignore` becomes `.gitignore`.
- Run the tests: they validate freshly generated skills.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). Versions come from commit messages, so **follow Conventional Commits**:

| Commit                                          | Release                                  |
| ----------------------------------------------- | ---------------------------------------- |
| `fix: …`                                        | patch (1.0.0 → 1.0.1)                    |
| `feat: …`                                       | minor (1.0.0 → 1.1.0)                    |
| `feat!: …` or a `BREAKING CHANGE:` footer       | major (1.0.0 → 2.0.0)                    |
| `docs:`                                         | no release, listed in the next changelog |
| `chore:`, `refactor:`, `test:`, `ci:`, `build:` | no release, hidden from the changelog    |

How a release happens (`.github/workflows/release.yml`):

1. **After CI passes on a push to `main`**, release-please opens or updates a `chore: release X.Y.Z` pull request. It bumps `package.json` and `package-lock.json`, and writes the `CHANGELOG.md` entry from the commits since the last release.
2. **Merge that pull request when you want to ship.** Until then it keeps accumulating changes.
3. **After CI passes on the merge commit**, release-please tags `vX.Y.Z` and creates the GitHub release. The `publish` job then publishes that exact commit to npm with provenance. `prepublishOnly` runs lint, typecheck, build and tests once more first.

Nothing is released if CI fails on `main`.

### One-time setup

- **npm token:** add an npm automation token as the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions). The `publish` job runs in the `npm` environment, which GitHub creates on first use. You can add required reviewers there for a manual approval before each publish.
- **Pull request permission:** in Settings → Actions → General → Workflow permissions, enable _Allow GitHub Actions to create and approve pull requests_.
- **CI on release pull requests (optional):** pull requests opened with the default `GITHUB_TOKEN` do not trigger the `ci` workflow. To get checks on them, add a fine-grained personal access token as `RELEASE_PLEASE_TOKEN` (repository contents and pull requests: read/write). The workflow uses it when present.
- **After the first release:** the first release is pinned to 1.0.0 with `"release-as": "1.0.0"` in `release-please-config.json`. Remove that line once 1.0.0 is published, otherwise every release PR would propose 1.0.0 again.

### Before merging a release pull request

- If it is a major release, bump the `skanvil` range in `templates/library/package.json` (for example `^2.0.0`) in a `fix:` or `chore:` commit first.
- Optionally smoke-test the tarball:
  ```bash
  npm pack --pack-destination /tmp/skanvil-smoke
  cd /tmp/skanvil-smoke && npm init -y && npm i ./skanvil-*.tgz
  npx skanvil init lib --no-git && npx skanvil add -C lib --type front --name x --description "X"
  npx skanvil validate -C lib
  ```

Never edit `version` in `package.json`, create `v*` tags or edit `CHANGELOG.md` by hand: release-please owns them.
