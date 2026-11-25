# Validation

`skanvil validate` checks four things:

- every skill, against the [Agent Skills specification](https://agentskills.io/specification);
- skill quality, context budgets, and lifecycle conventions configured for the library;
- `params.json` and `evals.json` files next to `SKILL.md`;
- the consistency of the README index.

It also runs automatically after `add` and `edit`.

**Which skills are checked:**

- Skills of categories with `validated: false` (the default `_internal`) are skipped.
- README checks only consider categories with `indexed: true`.

> **Breaking change from v1.x:** `Error Recovery` is now included in the default `validation.requiredSections` (`Objective`, `When to Activate This Skill`, `Instructions`, `Error Recovery`, `Output Format`, `Quality Criteria`). Existing libraries upgrading without updating older skills can configure `validation.requiredSections` explicitly in `.skanvilrc.json`.

## Rules

| Rule                   | Default | Fixable | Checks                                                                                                                   |
| ---------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `skill-file`           | error   |         | Each skill folder contains `SKILL.md`.                                                                                   |
| `frontmatter`          | error   |         | `SKILL.md` starts with valid YAML frontmatter between `---` delimiters, and it is a mapping.                             |
| `frontmatter-tabs`     | error   | ✓       | No tab characters in the frontmatter.                                                                                    |
| `folder-name`          | error   |         | The folder name is strict kebab-case (`_` allowed as the internal prefix).                                               |
| `name-required`        | error   | ✓       | Frontmatter `name` is present.                                                                                           |
| `name-format`          | error   |         | Spec: `name` is 1–64 characters of `a-z`, `0-9` and single hyphens, and does not start or end with a hyphen.             |
| `name-matches-folder`  | error   | ✓       | `name` equals the folder name.                                                                                           |
| `duplicate-name`       | error   |         | No two skills share a frontmatter `name`.                                                                                |
| `description-required` | error   |         | Frontmatter `description` is present.                                                                                    |
| `description-length`   | error   |         | Spec: `description` is at most 1024 characters.                                                                          |
| `description-budget`   | warn    |         | Stage-1 always-loaded metadata (`name` + `description`) stays within `validation.maxDescriptionTokens` (default: 120).   |
| `description-triggers` | warn    |         | `description` is at least 40 chars and includes trigger cues (e.g. `Use when ...`).                                      |
| `description-overlap`  | warn    |         | Validated skills have distinct descriptions (`jaccardSimilarity < validation.overlapThreshold`, default: `0.65`).        |
| `always-loaded-budget` | warn    |         | Total Stage-1 tokens across all validated skills stay within `validation.maxAlwaysLoadedTokens` (when configured).       |
| `compatibility-length` | error   |         | Spec: `compatibility`, when present, is 1–500 characters.                                                                |
| `metadata-format`      | warn    |         | Spec: `metadata` maps string keys to string values. Quote numbers: `version: "1.0"`.                                     |
| `allowed-tools-format` | warn    |         | Spec: `allowed-tools` is a space-separated string.                                                                       |
| `tools-field`          | warn    | ✓       | `tools` is not a spec field. Use `allowed-tools`.                                                                        |
| `required-sections`    | error   |         | The body contains every heading in `validation.requiredSections`.                                                        |
| `placeholders`         | error   |         | The file contains none of `validation.placeholders`.                                                                     |
| `max-lines`            | warn    |         | `SKILL.md` is at most `validation.maxLines` lines (spec recommendation: 500).                                            |
| `numbered-steps`       | warn    |         | `## Instructions` uses numbered steps (`1.`, `2.`) or numbered subsections (`### 1.`, `### 2.`).                         |
| `vague-fallback`       | warn    |         | Body (outside code fences) contains none of `validation.vagueFallbacks` (e.g. `"try again"`).                            |
| `error-recovery-table` | warn    |         | `## Error Recovery` (or `## Troubleshooting`), when present, contains a Markdown table of failures and actions.          |
| `broken-references`    | error   |         | Relative links and `references/`, `scripts/`, `assets/` paths in `SKILL.md` exist inside the skill folder.               |
| `unused-resources`     | warn    |         | Files in `references/`, `scripts/` and `assets/` are referenced from `SKILL.md` (ignores dotfiles like `.gitkeep`).      |
| `template-unchanged`   | warn    |         | The body no longer contains the generic sentences of the built-in skill template.                                        |
| `params-file`          | error   |         | `params.json`, when present, is valid (camelCase names, a type, a default). See [Parameters](params-and-exports.md).     |
| `params-template`      | error   |         | `{{…}}` placeholders and `{{#if}}` blocks use declared parameters and are balanced.                                      |
| `evals-file`           | error   |         | `evals.json`, when present, matches the schema, has unique case ids and valid `case.params` against `params.json`.       |
| `evals-required`       | off     |         | Opt-in rule requiring `evals.json` with at least one `shouldTrigger` and one `shouldNotTrigger` prompt per skill.        |
| `duplicate-trigger`    | warn    |         | Positive `shouldTrigger` prompts in `evals.json` are not claimed verbatim by multiple skills.                            |
| `no-secrets`           | error   |         | `SKILL.md` and text resources contain no hardcoded tokens, API keys, private keys, or Bearer credentials.                |
| `no-local-paths`       | warn    |         | `SKILL.md` and text resources avoid machine-specific home paths (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`). |
| `owner-required`       | off     |         | Opt-in rule requiring `metadata.owner`.                                                                                  |
| `status-valid`         | warn    |         | `metadata.status`, when present, is one of `draft`, `experimental`, `active`, `deprecated`.                              |
| `replaced-by-exists`   | error   |         | `metadata.replaced-by`, when present, points to an existing, publishable, non-deprecated skill in the library.           |
| `readme-missing`       | error   | ✓       | Every indexed skill is listed in the README.                                                                             |
| `readme-orphan`        | error   | ✓       | The README does not list skills that don't exist.                                                                        |
| `readme-section`       | error   | ✓       | Skills are listed under their own category's section.                                                                    |

**Placeholder and vague-fallback matching:**

- ALL-CAPS placeholders such as `TODO` match case-sensitively as whole words. `TODO:` and `(TODO)` match; `TODOS` and `todo` do not.
- Other placeholders and `validation.vagueFallbacks` match case-insensitively at word boundaries (and `vague-fallback` ignores fenced code blocks).

**Reference and unused-resource checking (`broken-references` & `unused-resources`):**

- Checked: relative Markdown link targets such as `[guide](references/guide.md)`, and backticked paths such as `` `scripts/run.sh` ``.
- Anchors and query strings are ignored, so `references/guide.md#usage` checks `references/guide.md`.
- Not checked: URLs, `mailto:`, `#anchors`, absolute paths, fenced code blocks, and patterns such as `scripts/<name>.sh` or `assets/*.png`.
- Links that leave the skill folder (`../other/SKILL.md`) are reported, because the spec keeps references inside the skill, one level deep.
- Backticked folder references such as `` `scripts/` `` satisfy `unused-resources` for files inside that folder without failing `broken-references`.

**Scaffold text (`template-unchanged`):** `skanvil add` copies generic instructions from the built-in template. They read fine but say nothing specific, so the rule warns until they are replaced. In libraries that run `validate --strict`, as the generated `npm test` does, a new skill fails CI until real content is written.

**Quality, overlap, and lifecycle rules:**

- `description-budget` and `always-loaded-budget` approximate tokens at ~4 characters per token over `name + "\n" + description`.
- `description-overlap` compares pairs of validated skills that each have at least 3 unique non-stopword content tokens, warning when Jaccard similarity meets or exceeds `validation.overlapThreshold` (`0.65`).
- `numbered-steps` checks `## Instructions` (outside fenced code blocks) for `1. ...` list items or `### 1. ...` numbered subsections.
- `error-recovery-table` checks `## Error Recovery` (or `## Troubleshooting`, outside fenced code blocks) for a Markdown table with a separator row (`| --- |`) and at least one body row.
- `replaced-by-exists` verifies that `metadata.replaced-by` names another publishable skill in the library whose `metadata.status` is not `"deprecated"`.
- **Security & hygiene rules (`no-secrets` & `no-local-paths`):** Scan `SKILL.md` and text resources under `references/`, `scripts/`, and `assets/` (skipping binary files and files over 1 MB). `no-secrets` detects GitHub, AWS, Slack, Google, OpenAI/Anthropic/Stripe keys, PEM private keys, and non-placeholder `Authorization: Bearer` tokens without echoing the secret text in diagnostics. `no-local-paths` flags developer home directories while allowing generic example usernames (`user`, `username`, `your-user`, `runner`, etc.).
- **Duplicate trigger rule (`duplicate-trigger`):** Normalizes whitespace, casing, and trailing punctuation on `evals.json` `shouldTrigger` entries and warns when a second skill declares the exact same positive prompt.

## Upgrading from v1.x

If an existing library had skills authored under v1.x defaults (5 required sections without `Error Recovery`, short descriptions, or unnumbered instructions), you can migrate at your own pace in `.skanvilrc.json`:

```json
{
  "validation": {
    "requiredSections": [
      "Objective",
      "When to Activate This Skill",
      "Instructions",
      "Output Format",
      "Quality Criteria"
    ],
    "rules": {
      "description-triggers": "off",
      "numbered-steps": "off"
    }
  }
}
```

Remove those overrides as you add `## Error Recovery` tables and sharpen each skill's description.

## Tuning severities

Override any rule per library in `.skanvilrc.json`:

```json
{
  "validation": {
    "maxDescriptionTokens": 120,
    "maxAlwaysLoadedTokens": 3000,
    "rules": {
      "max-lines": "off",
      "tools-field": "error",
      "evals-required": "error",
      "owner-required": "warn"
    }
  }
}
```

Severities and exit codes:

- `error` makes `validate` exit with 1.
- `warn` is reported, and fails only with `--strict`.
- `off` disables the rule (default for opt-in governance/eval rules such as `evals-required` and `owner-required`).

## Fixing problems

```bash
skanvil doctor                         # list problems; fixable ones are marked
skanvil doctor --fix                   # repair them, then re-validate
skanvil doctor --fix --scaffold-sections  # also insert stubs for missing requiredSections
skanvil index                          # regenerate the README index from scratch
```

Notes on `doctor`:

- `doctor --fix` only edits frontmatter metadata and README entries automatically; `--scaffold-sections` is opt-in and inserts minimal template stubs (including an `## Error Recovery` table) that retain a `template-unchanged` warning until customized.
- Converting `tools` to `allowed-tools` keeps the tool names as they were. Those names are often agent-specific (for example VS Code's `read_file`), so review them after the conversion.

## JSON, GitHub annotations & SARIF output

```bash
skanvil validate --json
skanvil validate --format github
skanvil validate --format sarif > skanvil.sarif
```

`--json` prints:

```json
{
  "ok": false,
  "diagnostics": [
    {
      "rule": "placeholders",
      "severity": "error",
      "skill": "front-api-review",
      "message": "contains a forbidden placeholder (\"TODO\")",
      "file": "skills/front-api-review/SKILL.md",
      "line": 14
    },
    {
      "rule": "readme-orphan",
      "severity": "error",
      "message": "README.md references a missing skill: back-old",
      "fixable": true
    }
  ],
  "count": 12,
  "errors": 2,
  "warnings": 0
}
```

`skill` is absent for library-level diagnostics (`readme-orphan`, `always-loaded-budget`).

- `--format github` prints `::error file=...,line=...,title=...::...` and `::warning ...` workflow commands so GitHub Pull Request diffs annotate exact skill files and line numbers inline.
- `--format sarif` emits SARIF 2.1.0 JSON ready for GitHub Code Scanning upload (`github/codeql-action/upload-sarif`).

## CI

Generated libraries already contain `.github/workflows/skills.yml`. For PR annotations and Code Scanning:

```yaml
- run: npm ci
- run: npx skanvil validate --strict --format github
- run: npx skanvil index --check
- run: npx skanvil eval triggers --strict
```

To validate a single skill while you write it:

```bash
skanvil validate --skill front-api-review
```
