# Contributing

## Setup

```bash
git clone https://github.com/jmbargueno/skanvil.git && cd skanvil
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
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

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

## Release checklist

Releases are published by `.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed. The workflow:

- checks that the tag matches `package.json`;
- runs every check;
- publishes to npm with provenance;
- creates the GitHub release.

It needs an `NPM_TOKEN` repository secret (an npm automation token).

1. `npm run lint && npm run format:check && npm run typecheck && npm run build && npm test`
2. Update `CHANGELOG.md` and bump `version` in `package.json` (`npm version <patch|minor|major> --no-git-tag-version`). If the major version changes, also bump the `skanvil` range in `templates/library/package.json`.
3. Smoke-test the tarball:
   ```bash
   npm pack --pack-destination /tmp/skanvil-smoke
   cd /tmp/skanvil-smoke && npm init -y && npm i ./skanvil-*.tgz
   npx skanvil init lib --no-git && npx skanvil add -C lib --type front --name x --description "X"
   npx skanvil validate -C lib
   ```
4. Commit, then tag and push: `git tag v1.2.3 && git push origin main v1.2.3`.
