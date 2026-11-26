# skanvil reference

## Commands

Every command accepts `-C, --cwd <path>` (library root) and `--json` (except `eval export`, which prints JSON directly). Exit code `0` means success; `1` means an error or failed check.

| Command                          | Options                                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [dir]`                     | `--name`, `--scope`, `--description`, `--profile front,back,transversal`, `--no-git`, `--eject-templates`, `--no-agent-skill`, `--no-feedback`, `--target <preset\|path>`                       |
| `add`                            | `--type <category>`, `--name`, `--title`, `--description`, `--template <name>`, `--no-assets`, `--no-references`, `--no-scripts`, `--skip-validate`                                             |
| `import <sourceDir>`             | `--type <category>`, `--skill <name>`, `--dry-run`, `--overwrite`, `--skip-validate`                                                                                                            |
| `edit <skill>`                   | `--rename`, `--type`, `--title`, `--description`, `--owner`, `--status <draft\|experimental\|active\|deprecated>`, `--replaced-by <skill>`, `--remove`, `--yes`, `--skip-validate`              |
| `list`                           | `--category <id>`, `--status <value>`, `--owner <value>`                                                                                                                                        |
| `validate`                       | `--strict`, `--skill <name>`, `--format <text\|github\|sarif\|json>`                                                                                                                            |
| `diff [baseRef]`                 | `--format <text\|markdown>`                                                                                                                                                                     |
| `index`                          | `--check`                                                                                                                                                                                       |
| `doctor`                         | `--fix`, `--scaffold-sections`                                                                                                                                                                  |
| `stats`                          | `--category <id>`, `--skill <name>`, `--sort <tokens\|lines\|name>`                                                                                                                             |
| `eval route "<p>"`               | `--top <n>`                                                                                                                                                                                     |
| `eval triggers`                  | `--skill <name>`, `--split <train\|eval>`, `--strict`                                                                                                                                           |
| `eval export`                    | `--format <json\|promptfoo>`, `--ablation`, `--skill <name>`, `--split <train\|eval>`, `--out <file>`                                                                                           |
| `feedback list`                  | `--file <path>`, `--skill <name>`                                                                                                                                                               |
| `feedback promote`               | `--file <path>`, `--skill <name>`, `--dry-run`, `--prune`                                                                                                                                       |
| `feedback push`                  | `--file <path>`, `--skill <name>`, `--endpoint <url>`, `--api-key <key>`, `--dry-run`, `--no-queue`                                                                                             |
| `telemetry snapshot`             | `--endpoint <url>`, `--api-key <key>`, `--dry-run`, `--no-queue`                                                                                                                                |
| `telemetry emit`                 | `--skill <name>`, `--library`, `--agent`, `--model`, `--outcome`, `--duration-ms`, `--tool-calls`, `--failed-tool-calls`, `--endpoint`, `--api-key`, `--dry-run`, `--no-queue`                  |
| `telemetry hook`                 | `--agent <claude\|cursor\|gemini>`, `--endpoint <url>`, `--api-key <key>`                                                                                                                       |
| `telemetry push`                 | `--endpoint <url>`, `--api-key <key>`, `--dry-run`                                                                                                                                              |
| `telemetry install-hooks [dest]` | `--target <claude\|cursor\|gemini>`, `--global`, `--dry-run`                                                                                                                                    |
| `templates eject`                | `--category <id>`, `--force`                                                                                                                                                                    |
| `sync [dest]`                    | `--target <preset\|path>`, `--from <pkg\|path\|git>`, `--link`, `--copy`, `--category`, `--skill`, `--status`, `--include-deprecated`, `--force`, `--dry-run`, `--global`, `--param name=value` |
| `build`                          | `--out <dir>`, `--force`                                                                                                                                                                        |
| `install-skill [dest]`           | `--target <preset\|path>`, `--force`, `--global`, `--no-feedback`                                                                                                                               |

## `.skanvilrc.json`

```jsonc
{
  "$schema": "./node_modules/skanvil/schema.json",
  "name": "my-skills",
  "skillsDir": "skills",
  "readme": "README.md",
  "categories": [
    {
      "id": "front",
      "prefix": "front-",
      "title": "Front",
      "aliases": ["frontend", "f"],
      "default": false,
      "indexed": true,
      "validated": true,
      "metadata": { "domain": "frontend" },
      "compatibility": "Designed for frontend repositories."
    }
  ],
  "validation": {
    "requiredSections": [
      "Objective",
      "When to Activate This Skill",
      "Instructions",
      "Error Recovery",
      "Output Format",
      "Quality Criteria"
    ],
    "placeholders": ["describe...", "lorem ipsum", "tbd", "to be defined"],
    "maxLines": 500,
    "maxDescriptionTokens": 120,
    "maxAlwaysLoadedTokens": 4000,
    "overlapThreshold": 0.65,
    "vagueFallbacks": ["try again", "retry if it fails", "retry until it works", "just retry"],
    "rules": { "max-lines": "warn", "evals-required": "off", "owner-required": "off" }
  },
  "templates": { "dir": ".skanvil/templates" },
  "sync": { "targets": ["claude"], "mode": "copy" },
  "telemetry": { "enabled": false, "endpoint": "https://skanvil-hub.internal", "timeoutMs": 1500 }
}
```

## Validation rules

Default severity is `error` unless noted. Rules marked with `*` are fixable by `doctor --fix`.

- **Files and YAML:** `skill-file`, `frontmatter`, `frontmatter-tabs`\*.
- **Names:** `folder-name`, `name-required`\*, `name-format`, `name-matches-folder`\*, `duplicate-name`.
- **Spec fields:** `description-required`, `description-length` (<= 1024), `compatibility-length` (1-500), `metadata-format` (warn), `allowed-tools-format` (warn), `tools-field`\* (warn).
- **Content & quality:** `required-sections`, `placeholders`, `max-lines` (warn), `broken-references`, `unused-resources` (warn), `template-unchanged` (warn), `description-budget` (warn), `description-triggers` (warn), `numbered-steps` (warn), `vague-fallback` (warn), `error-recovery-table` (warn), `description-overlap` (warn), `always-loaded-budget` (warn).
- **Security & hygiene:** `no-secrets`, `no-local-paths` (warn).
- **Parameters & evals:** `params-file`, `params-template`, `evals-file`, `evals-required` (off), `duplicate-trigger` (warn).
- **Governance:** `owner-required` (off), `status-valid` (warn), `replaced-by-exists`.
- **README:** `readme-missing`\*, `readme-orphan`\*, `readme-section`\*.

## JSON output shapes

- `list --json` prints `[{ name, type, indexed, valid, status?, owner?, replacedBy?, description }]`.
- `validate --json` prints `{ ok, diagnostics: [{ rule, severity, skill?, message, fixable?, file?, line? }], count, errors, warnings }`.
- `diff --json` prints `{ baseRef, added, removed, modified, unchangedCount, stage1Tokens, newDiagnostics, resolvedDiagnosticsCount, triggerRegressions }`.
- `import --json` prints `{ sourceDir, dryRun, imported: [{ source, target, type, status, changes }], skipped }`.
- `doctor --json` prints the same as validate, plus `fixes: string[]`.
- `stats --json` prints `{ count, totals: { alwaysLoadedTokens, bodyTokens, bodyLines, resourceFiles, resourceTokens, unreferencedFiles }, skills: [{ name, category, status?, alwaysLoaded, body, resources, totalEstimatedTokens }] }`.
- `eval route --json` prints `{ prompt, queryTokens, totalSkills, candidates: [{ skill, rank, score, matchedTokens, description }] }`.
- `eval triggers --json` prints `{ ok, total, passed, failed, bySplit, results: [{ skill, kind, prompt, split?, passed, expectedRank, topSkill, topScore, targetScore, reason? }] }`.
- `feedback list --json` prints `{ file, totalEntries, uniqueGroups, invalidLines, groups }` and `feedback promote --json` prints `{ file, dryRun, promoted, skipped, invalidLines, prunedLines }`.
- `telemetry snapshot|emit --json` and `feedback push --json` print `{ sent, queued, dryRun, skippedReason?, error?, events }`, `telemetry push --json` adds `{ remaining, invalidLines }`, and `telemetry install-hooks --json` prints `{ dryRun, scope, results: [{ agent, file, status }] }`.
- `index --json` prints `{ updated }`, or `{ upToDate }` with `--check`.
- `sync --json` prints `{ dryRun, mode, results: [{ target, path, added, updated, unchanged, removed, skipped: [{ skill, reason }], warnings, params, alwaysLoadedTokens }] }`.
- `add --json` prints `{ skillName, title, type, target, template }`.
- `edit --json` prints `{ skillName, previousName }`, or `{ removed }`.
- `install-skill --json` prints `[{ skill, target, path, status, reason? }]`.

## Parameters (`params.json`) and Evaluations (`evals.json`)

```json
{
  "ticketTracker": {
    "type": "enum",
    "values": ["github", "jira"],
    "default": "github",
    "description": "Issue tracker"
  },
  "packageManager": { "type": "string", "default": "npm" },
  "strict": { "type": "boolean", "default": false }
}
```

The syntax inside `SKILL.md`:

- `{{name}}` inserts the value;
- `{{#if name}}`, `{{#if !name}}`, `{{#if name == "v"}}` and `{{#if name != "v"}}` start a block;
- `{{else}}` and `{{/if}}` continue and close it.

Optional `evals.json` next to `SKILL.md` (excluded from `sync` and `build`):

```json
{
  "triggers": {
    "shouldTrigger": [
      { "prompt": "Audit accessibility of the checkout modal", "split": "train" },
      { "prompt": "Check WCAG contrast in this form", "split": "eval" }
    ],
    "shouldNotTrigger": [{ "prompt": "Add a database index migration", "split": "eval" }]
  },
  "cases": [
    {
      "id": "modal-audit",
      "split": "eval",
      "prompt": "Audit src/Modal.tsx for keyboard traps.",
      "expected": ["Identifies focus trapping issues and proposes concrete ARIA fixes."],
      "mustContain": ["aria-"],
      "mustNotContain": ["placeholder"]
    }
  ]
}
```

## Template variables

The following variables are available in custom templates. In the `SKILL.md` frontmatter they are YAML-escaped automatically.

- `{{name}}`, `{{title}}`, `{{description}}`, `{{descriptionLower}}`;
- `{{category}}`, `{{domain}}`, `{{compatibility}}`;
- `{{resources}}`;
- `{{metadata.<key>}}`.
