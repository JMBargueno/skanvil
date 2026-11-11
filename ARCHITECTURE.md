# Architecture

skanvil is a TypeScript ESM package. `tsup` bundles `src/` into `dist/` with two entry points: `dist/cli.js` (the `skanvil` binary) and `dist/index.js` (the programmatic API, typed by `dist/index.d.ts`).

## Module map

```text
src/
├── cli.ts                 commander program: commands, options, error → exit code
├── index.ts               public API (re-exports from core/ and commands/)
├── commands/              thin CLI layer: options → core call → text or JSON output
│   ├── shared.ts          --cwd handling, diagnostic printing, post-mutation validation
│   ├── skills.ts          add, edit, list (interactive prompts via @inquirer/prompts)
│   ├── library.ts         init, validate, index, doctor, templates eject, install-skill, sync
│   └── wizard.ts          interactive menu-driven assistant on top of the same core calls
├── core/                  all behaviour; no console output, no process exit
│   ├── config.ts          .skanvilrc.json zod schema, default preset, resolution and checks
│   ├── categories.ts      id/alias lookup, longest-prefix inference, name and title building
│   ├── library.ts         Library: paths, skill listing, SKILL.md and README I/O (keeps EOL)
│   ├── skill.ts           SkillFile: frontmatter as a YAML Document (round-trip safe)
│   ├── readme-index.ts    pure functions over the README index (LF text in, LF text out)
│   ├── validate.ts        rule registry and engine → Diagnostic[]
│   ├── skills.ts          scaffoldSkill, editSkill (transactional), removeSkill
│   ├── reindex.ts         rebuildIndex (regenerate) and reconcileIndex (minimal repair)
│   ├── doctor.ts          diagnosis and automatic fixes
│   ├── templates.ts       {{variable}} rendering, template lookup, eject
│   ├── sync.ts            installation into agent folders, manifest, pruning, --param rendering
│   ├── params.ts          params.json schema, template renderer ({{name}}, {{#if}}), value checks
│   ├── build.ts           skanvil build: typed ESM/CJS exports with the renderer embedded
│   ├── agent-skill.ts     install/update the bundled `skanvil` agent skill
│   ├── init.ts            createLibrary
│   └── naming.ts          kebab-case, title case, sentences
└── util/                  paths (package root via import.meta.url), eol, fs, output

agent-skill/skanvil/       the `skanvil` agent skill (SKILL.md + references/) shipped to users

templates/
├── library/               skeleton copied by `init` (gitignore is renamed to .gitignore)
└── skill/                 default skill: SKILL.md + assets/, references/, scripts/

tests/                     vitest: unit, core end-to-end, and real-CLI suites (tests/setup bundles the CLI)
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

- **Configuration over constants.** Nothing about a library's conventions is hard-coded: prefixes, README titles, aliases, per-category metadata, required sections and placeholders all live in `.skanvilrc.json`. `DEFAULT_CATEGORIES` is applied when a library has no `categories`.
- **One prefix-less default category.** A folder belongs to the category with the longest matching prefix, otherwise to the default one. The config loader rejects ambiguous setups: two defaults, a prefix that starts with another prefix, or duplicated aliases or titles.
- **Plain-markdown README index.** Entries are `- Title` / `\t- Description:` / `` \t- Folder: `skills/x` `` inside `<details><summary><strong>Title</strong></summary>`. `readme-index.ts` works on LF strings only; `Library` detects CRLF on read and restores it on write.
- **Real YAML, minimal diffs.** `SkillFile` keeps a `yaml` Document. Untouched frontmatter is written back byte for byte, and edited frontmatter is re-serialised without line folding. Template values in the frontmatter are YAML-escaped.
- **Transactional edits.** `editSkill` computes the new `SKILL.md` and README in memory, writes them, and renames the folder last. On failure it restores both files.
- **Structured diagnostics.** Each diagnostic carries `rule`, `severity`, `skill`, `message` and `fixable`. This one shape drives text output, `--json`, `doctor --fix` and the sync safety check.
- **Idempotent sync.** A `.skanvil-sync.json` manifest per target is the only authority on what skanvil may update or delete, so foreign skills are never touched. `--link` uses junctions on Windows, which need no admin rights.
- **The tool documents itself for agents.** `agent-skill/skanvil` is a normal Agent Skill. A test validates it with skanvil's own default rules, and it must contain no warnings. Installed copies are stamped with `metadata.skanvil-version`; the stamp marks the folder as owned by skanvil, so it can be updated after upgrades.
- **Templates are data.** Changing how a skill or a library looks never requires touching `src/`.
- **Supported Node versions drive dependency choices.** Dependencies are pinned to majors that support Node 20: commander 14, @inquirer/prompts 7 and vitest 3.
