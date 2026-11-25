# Architecture

skanvil is a TypeScript ESM package. `tsup` bundles `src/` into `dist/` with two entry points: `dist/cli.js` (the `skanvil` binary) and `dist/index.js` (the programmatic API, typed by `dist/index.d.ts`).

## Module map

```text
src/
├── cli.ts                 commander program: commands, options, error → exit code
├── index.ts               public API (re-exports from core/ and commands/)
├── commands/              thin CLI layer: options → core call → text or JSON output
│   ├── shared.ts          --cwd handling, diagnostic printing, post-mutation validation
│   ├── skills.ts          add, edit (including lifecycle), list (with filters), import
│   ├── library.ts         init, validate, diff, index, doctor, stats, templates eject, build, install-skill, sync
│   ├── evals.ts           eval triggers, eval route, eval export
│   ├── feedback.ts        feedback list, feedback promote
│   └── wizard.ts          interactive menu-driven assistant on top of the same core calls
├── core/                  all behaviour; no console output, no process exit
│   ├── config.ts          .skanvilrc.json zod schema, default preset, resolution and checks
│   ├── categories.ts      id/alias lookup, longest-prefix inference, name and title building
│   ├── library.ts         Library: paths, skill listing, SKILL.md / params / evals / README I/O (keeps EOL)
│   ├── skill.ts           SkillFile: frontmatter as a YAML Document (round-trip safe)
│   ├── readme-index.ts    pure functions over the README index (LF text in, LF text out)
│   ├── text.ts            token estimation, fenced-code stripping, section extraction, tokenization, Jaccard
│   ├── validate.ts        rule registry and engine → Diagnostic[] (spec, quality, security, triggers, README)
│   ├── validate-format.ts GitHub Actions annotations (`::error`/`::warning`) and SARIF 2.1.0 formatters
│   ├── stats.ts           3-stage context-budget analyzer (`name`+`description`, body, resources)
│   ├── evals.ts           evals.json schema, offline BM25 trigger checker/router, JSON/Promptfoo exporter
│   ├── feedback.ts        .skanvil-feedback.jsonl parser, deduplication summarizer, and evals.json promoter
│   ├── skills.ts          scaffoldSkill, editSkill (transactional), removeSkill, frontmatter helpers
│   ├── import.ts          bulk external skill importer with frontmatter normalization and rollback
│   ├── diff.ts            git read-tree/checkout-index snapshot diff for tokens, params and regressions
│   ├── reindex.ts         rebuildIndex (regenerate) and reconcileIndex (minimal repair)
│   ├── doctor.ts          diagnosis, automatic repairs and opt-in missing-section scaffolding
│   ├── templates.ts       {{variable}} rendering, template lookup, eject
│   ├── sync.ts            multi-library Manifest v2 installation, Git --from cloning, pruning, --param rendering
│   ├── params.ts          params.json schema, template renderer ({{name}}, {{#if}}), value checks
│   ├── build.ts           skanvil build: typed ESM/CJS exports with the renderer embedded
│   ├── agent-skill.ts     install/update the bundled `skanvil` and `skanvil-feedback` agent skills
│   ├── init.ts            createLibrary
│   └── naming.ts          kebab-case, title case, sentences
└── util/                  paths (package root via import.meta.url), eol, fs, output

agent-skill/
├── skanvil/               the `skanvil` agent skill (SKILL.md + references/) shipped to users
└── skanvil-feedback/      the `skanvil-feedback` skill for logging friction reports

templates/
├── library/               skeleton copied by `init` (gitignore is renamed to .gitignore)
└── skill/                 default skill: SKILL.md + assets/, references/, scripts/

tests/                     vitest: unit, core end-to-end, params/build, wizard and real-CLI suites
scripts/build-schema.mjs   writes schema.json from the zod schema after the build
docs/                      user guides (docs/assets is not published to npm)
.github/workflows/         ci.yml (lint, format, typecheck, build, test) and release.yml (release-please PR + npm publish after green CI on main)
```

## Data flow

```text
skanvil add --type front --name x --description y
   │
   ▼
cli.ts ──► commands/skills.ts: addCommand(options)
              │  openLibrary(--cwd) ──► core/library.ts: Library.open
              │                           └─ core/config.ts: loadConfig → resolveConfig
              ▼
           core/skills.ts: scaffoldSkill(library, …)
              ├─ categories.buildName / buildTitle
              ├─ templates.resolveSkillTemplate → copyTemplateDir (renderSkillMarkdown)
              ├─ SkillFile: apply category metadata
              └─ readme-index.insertEntry → library.writeReadme
              ▼
           commands/shared.ts: validateAfter ──► core/validate.ts: validateLibrary
```

Every command follows the same pattern:

1. The command opens a `Library`, which loads and resolves the config.
2. It calls a core function.
3. It prints the result with `Output`, as text or JSON.

Core functions accept a `Library`, or a root path, and never print.

## Design decisions

- **Configuration over constants.** Nothing about a library's conventions is hard-coded: prefixes, README titles, aliases, per-category metadata, required sections, placeholders, token limits, similarity thresholds and vague fallbacks all live in `.skanvilrc.json`. `DEFAULT_CATEGORIES` is applied when a library has no `categories`.
- **One prefix-less default category.** A folder belongs to the category with the longest matching prefix, otherwise to the default one. The config loader rejects ambiguous setups: two defaults, a prefix that starts with another prefix, or duplicated aliases or titles.
- **Plain-markdown README index.** Entries are `- Title` / `\t- Description:` / `` \t- Folder: `skills/x` `` inside `<details><summary><strong>Title</strong></summary>`. `readme-index.ts` works on LF strings only; `Library` detects CRLF on read and restores it on write.
- **Real YAML, minimal diffs.** `SkillFile` keeps a `yaml` Document. Untouched frontmatter is written back byte for byte, and edited frontmatter is re-serialised without line folding. Template values in the frontmatter are YAML-escaped.
- **Transactional edits.** `editSkill` computes the new `SKILL.md` and README in memory, writes them, and renames the folder last. On failure it restores both files.
- **Structured diagnostics & CI formats.** Each diagnostic carries `rule`, `severity`, `skill`, `message`, `fixable`, plus optional `file` and `line`. Rules default to `error`, `warn` or `off` (for opt-in checks such as `evals-required` and `owner-required`). One engine drives text output, `--json`, GitHub Actions workflow annotations (`--format github`), SARIF 2.1.0 (`--format sarif`), `doctor --fix` and the sync safety check.
- **Offline, LLM-agnostic quality & evals.** Token budgets use a deterministic ~4-chars/token estimator (`src/core/text.ts`) and trigger routing checks/simulations (`eval triggers`, `eval route`) share an embedded zero-dependency Okapi BM25 scorer with non-negative Lucene-style IDF (`src/core/evals.ts`). LLM-graded ablation benchmarks are delegated to external runners via `skanvil eval export --format promptfoo --ablation`, while `skanvil feedback promote` turns `.skanvil-feedback.jsonl` reports directly into `evals.json` regression cases.
- **Spec-compliant lifecycle metadata & PR diffing.** Ownership (`metadata.owner`), lifecycle state (`metadata.status`), and deprecation pointers (`metadata.replaced-by`) live inside `metadata`. `syncSkills` excludes and prunes `deprecated` skills by default, `buildLibrary` emits `@deprecated` JSDoc tags, and `diffLibrary` extracts read-only base commits with `git read-tree`/`git checkout-index` to measure token deltas and regressions.
- **Multi-library idempotent sync.** Each target stores a v2 `.skanvil-sync.json` manifest (transparently reading and upgrading v1 manifests) keyed by source path or canonical Git specifier (`github:org/repo[#ref]`, `git+https://...`). Pruning and `--param` state are isolated per library source, collisions with other libraries or foreign folders are skipped cleanly, `alwaysLoadedTokens` sums across every installed skill, and `--link` uses junctions on Windows (automatically falling back to copy for temporary Git clones).
- **The tool documents itself for agents.** `agent-skill/skanvil` and `agent-skill/skanvil-feedback` are standard Agent Skills. Tests validate both with skanvil's own default rules, individually and side by side, with zero warnings. Installed copies are stamped with `metadata.skanvil-version`; the stamp marks the folder as owned by skanvil, so it can be updated after upgrades.
- **Templates are data.** Changing how a skill or a library looks never requires touching `src/`.
- **Supported Node versions drive dependency choices.** Dependencies are pinned to majors that support Node 20: commander 14, @inquirer/prompts 7 and vitest 3.
