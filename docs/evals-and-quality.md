# Evals, context budgets, and skill quality

Large skill libraries fail in predictable ways: descriptions bloat the always-loaded context window, sibling skills collide on routing, instructions lack concrete verification or recovery paths, and skills silently break when tools or models evolve.

skanvil gives you a local, deterministic toolkit to prevent those failures without tying your library to any single LLM provider.

## The closed quality loop

```text
  Add / Edit Skill ─► skanvil validate ─► skanvil stats ─► skanvil eval triggers
         ▲                                                          │
         │                                                          ▼
   evals.json case ◄─ .skanvil-feedback.jsonl ◄─ skanvil sync ◄─ eval export (ablation)
```

1. **Author** skills with clear trigger boundaries, numbered verifiable steps, and a concrete `## Error Recovery` table.
2. **Validate & measure** structure, overlap, and 3-stage context size locally and in CI (`validate --strict`, `stats`).
3. **Verify routing** offline against sibling descriptions (`eval triggers --strict`) and run LLM ablation benchmarks externally (`eval export --format promptfoo --ablation`).
4. **Ship safely** (`sync` skips and prunes `deprecated` skills; `build` adds `@deprecated` JSDoc tags).
5. **Close the loop** when `skanvil-feedback` logs real session friction into `.skanvil-feedback.jsonl`—turn the failure into a regression case in `evals.json` before editing `SKILL.md`.

---

## 1. Three-stage progressive loading (`skanvil stats`)

Coding agents load skills in three stages:

1. **Stage 1 (always loaded):** only `name` and `description`. Every installed skill shares this budget in every conversation.
2. **Stage 2 (loaded when triggered):** the `SKILL.md` body.
3. **Stage 3 (loaded on demand):** files inside `references/`, `scripts/` and `assets/`.

Measure your library with:

```bash
skanvil stats --sort tokens
skanvil stats --category front --json
```

Example output:

```text
SKILL              STAGE 1  LINES  BODY TOK     RESOURCES  UNUSED
front-a11y-extra      ~27t     52     ~539t      3 (218t)       0
front-a11y            ~23t     52     ~523t      3 (218t)       0
back-old-sql          ~22t     56     ~535t      3 (218t)       0
[stats] Totals: ~72 always-loaded tokens, 160 lines (~1597 tokens), 9 resource(s) (~654 tokens) across 3 skill(s).
```

> **Note:** Token counts use a deterministic ~4-characters-per-token approximation (`estimateTokens`) so budgets work offline across any model provider without extra runtime dependencies.

`skanvil validate` enforces these budgets using:

- `description-budget` (default `warn`, `validation.maxDescriptionTokens: 120`) — keeps `name` + `description` compact (~100 tokens).
- `always-loaded-budget` (default `warn` when `validation.maxAlwaysLoadedTokens` is set) — caps the Stage-1 total across the whole library.
- `max-lines` (default `warn`, `validation.maxLines: 500`) — encourages moving long guidance into `references/`.
- `unused-resources` (default `warn`) — flags files under `references/`, `scripts/` or `assets/` that are never linked from `SKILL.md`.

`skanvil sync` also computes and displays the resulting Stage-1 footprint for each target:

```text
[sync] (dry run) claude -> my-app/.claude/skills: 2 added, 0 updated, 0 unchanged, 0 removed (~50 always-loaded tokens)
   + front-a11y
   + front-a11y-extra
[sync]    skipped back-old-sql: deprecated (replaced by front-a11y; use --include-deprecated)
```

---

## 2. Structural quality rules (before vs. after)

`skanvil validate` catches common skill anti-patterns:

- `description-triggers` — ensures `description` is at least 40 characters and explains _when_ to activate the skill.
- `description-overlap` — flags pairs of skills whose `name` + `description` share high lexical overlap (`validation.overlapThreshold`, default `0.65`), preventing routing ambiguity.
- `numbered-steps` — checks that `## Instructions` uses numbered steps (`1.`, `2.`) or numbered subsections (`### 1.`, `### 2.`).
- `error-recovery-table` — checks that `## Error Recovery` (part of `DEFAULT_REQUIRED_SECTIONS`) maps failures to concrete actions using a Markdown table.
- `vague-fallback` — flags weak recovery advice such as `"try again"` (configurable via `validation.vagueFallbacks`, ignoring fenced code blocks).

### Before (triggers quality warnings)

```markdown
---
name: back-migrations
description: Helps with migrations.
---

## Instructions

Check the schema and update the files. Make sure nothing breaks.

## Error Recovery

If the migration fails, try again after checking the database.
```

Problems reported: `description-triggers` (< 40 chars, no activation cue), `numbered-steps` (prose instead of numbered steps), `error-recovery-table` (missing table), and `vague-fallback` (`"try again"`).

### After (clean, verifiable, zero warnings)

```markdown
---
name: back-migrations
description: Audits Postgres SQL migrations for table locks, backwards compatibility and rollback safety. Use when adding or modifying database migrations; do not use for application ORM queries.
metadata:
  domain: backend
  owner: "@data-platform"
  status: active
  version: "1.0"
---

# Back Migrations

## Objective

Prevent locking outages and irreversible schema changes during database migrations.

## When to Activate This Skill

- A change adds or edits SQL files under `migrations/`.
- Do not activate for read-only reporting queries or seed data scripts.

## Instructions

1. Inspect the SQL diff for `ALTER TABLE` statements that acquire `ACCESS EXCLUSIVE` locks.
2. Verify every destructive operation has a reversible down-migration or expand/contract plan.
3. Run `npm run db:lint` and confirm exit code `0` before approving.

## Error Recovery

| Failure                                   | Cause                                  | Recovery Action                                                                                      |
| ----------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `db:lint` fails with lock timeout warning | Unindexed foreign key or table rewrite | Split into `ADD CONSTRAINT ... NOT VALID` followed by `VALIDATE CONSTRAINT` in a separate migration. |
| Missing local Postgres test database      | Service container not running          | Report the missing prerequisite and stop instead of guessing migration behavior.                     |

## Output Format

- Summary of lock risks, rollback readiness and `db:lint` output.

## Quality Criteria

- Every `ALTER TABLE` risk is explicitly assessed and `npm run db:lint` exited `0`.
```

---

## 3. Declarative evaluations (`evals.json`)

Add an optional `evals.json` file next to `SKILL.md` to declare routing tests and golden cases. Both `sync` and `build` exclude `evals.json`, so evaluations never consume runtime context tokens.

```json
{
  "triggers": {
    "shouldTrigger": [
      { "prompt": "Review this React checkout component for WCAG keyboard issues", "split": "train" },
      { "prompt": "Audit modal focus trapping and ARIA labels", "split": "eval" }
    ],
    "shouldNotTrigger": [{ "prompt": "Optimize the Postgres migration index", "split": "eval" }]
  },
  "cases": [
    {
      "id": "modal-focus-trap",
      "split": "eval",
      "params": { "strict": true },
      "prompt": "Audit src/Modal.tsx for accessibility issues.",
      "expected": ["Identifies keyboard focus trap issues and proposes concrete ARIA attributes."],
      "mustContain": ["aria-"],
      "mustNotContain": ["placeholder"]
    }
  ]
}
```

### `evals.json` field reference

| Field                       | Type                         | Required | Description                                                                    |
| --------------------------- | ---------------------------- | -------- | ------------------------------------------------------------------------------ |
| `triggers.shouldTrigger`    | `(string \| TriggerEntry)[]` | No       | Prompts that should route to this skill (`#1` rank, no tie).                   |
| `triggers.shouldNotTrigger` | `(string \| TriggerEntry)[]` | No       | Prompts that must not route to this skill.                                     |
| `TriggerEntry.prompt`       | `string`                     | Yes      | Prompt text when using object form.                                            |
| `TriggerEntry.split`        | `"train" \| "eval"`          | No       | Split tag to separate tuning prompts (`train`) from held-out prompts (`eval`). |
| `TriggerEntry.note`         | `string`                     | No       | Optional maintainer note explaining the boundary.                              |
| `cases[].id`                | `string` (kebab-case)        | Yes      | Case identifier, unique within the skill.                                      |
| `cases[].prompt`            | `string`                     | Yes      | User request passed to the external LLM runner.                                |
| `cases[].params`            | `{ [k]: string \| boolean }` | No       | Parameter overrides validated against `params.json`.                           |
| `cases[].expected`          | `string[]` (min 1)           | Yes      | Rubric assertions exported as `llm-rubric` checks in Promptfoo.                |
| `cases[].mustContain`       | `string[]`                   | No       | Case-insensitive required substrings (`icontains` in Promptfoo).               |
| `cases[].mustNotContain`    | `string[]`                   | No       | Case-insensitive forbidden substrings (`not-icontains` in Promptfoo).          |
| `cases[].split`             | `"train" \| "eval"`          | No       | Optional split tag for filtering exports (`--split`).                          |

Splitting items into `"train"` (used while tuning descriptions) and `"eval"` (held out for validation) helps avoid overfitting descriptions to a narrow set of test phrases.

### Offline trigger collision check

Run the built-in Okapi BM25 router against every non-deprecated skill's `name` + `description`:

```bash
skanvil eval triggers
skanvil eval triggers --split eval --strict
skanvil eval route "Audit React modal keyboard focus" --top 3
```

- `skanvil eval route "<prompt>"` scores any ad-hoc user prompt against every active skill (`rank`, `score`, `matchedTokens`, and `description`) so authors can immediately test why a prompt picks one skill over another.
- `duplicate-trigger` (`validate`, default `warn`) flags positive `shouldTrigger` prompts claimed verbatim by multiple skills across `evals.json` files.

Example outputs:

```text
# Clean run
[eval] Passed 4/4 trigger check(s) (train: 1/1, eval: 3/3).

# Routing collision detected
[eval]  - front-a11y [shouldTrigger (eval)]: "Review Postgres SQL database migration locks" -> ranked #2 behind 'back-sql' (score 7.42 vs 0.00)
[eval] 1 of 3 trigger check(s) failed (train: 1/1, eval: 1/2).
```

With `--strict`, `skanvil eval triggers` exits `1` whenever a `shouldTrigger` prompt fails to rank its skill `#1` (or ties with another skill), or when a `shouldNotTrigger` prompt falsely routes to the skill. Deprecated skills are excluded from the routing index so retired descriptions stop interfering with active skills.

> **Scope note:** Offline BM25 checks catch lexical collisions and missing keywords fast and free. Semantic paraphrasing and full multi-turn instruction adherence are tested by exporting to an LLM runner.

### Exporting for LLM runners & blind ablation

Export cases as JSON or as a [Promptfoo](https://www.promptfoo.dev/) config, optionally pairing `with-skill` against a `without-skill` baseline (`--ablation`):

```bash
skanvil eval export --format promptfoo --ablation --split eval --out evals.promptfoo.json
npx promptfoo eval -c evals.promptfoo.json
```

When `--ablation` is passed, Promptfoo evaluates every test case twice—once with the rendered `SKILL.md` (`with-skill`) and once with only the raw user prompt (`without-skill`)—so you can verify with real models that the skill measurably improves output quality over the baseline.

---

## 4. Governance, ownership, and deprecation

Use standard `metadata` keys via `skanvil edit` to manage catalog growth cleanly:

```bash
skanvil edit front-api-review --owner "@frontend-platform" --status active
skanvil edit front-legacy-form --status deprecated --replaced-by front-form-v2
skanvil list --status deprecated
```

- `owner-required` (`off` by default) and `status-valid` (`warn`) enforce metadata hygiene.
- `replaced-by-exists` (`error`) ensures replacement pointers resolve to an active, publishable skill.
- `skanvil sync` skips `deprecated` skills by default and prunes previously synced copies (override with `--include-deprecated` or `--status deprecated`).
- `skanvil build` adds `@deprecated` JSDoc annotations to exported TypeScript declarations.

---

## 5. Continuous improvement with `skanvil-feedback`

`skanvil init` and `skanvil install-skill` install `skanvil-feedback` alongside `skanvil` by default (pass `--no-feedback` to opt out). When an agent encounters stale steps, missing prerequisites or wasted loops while following any skill, `skanvil-feedback` guides it to append a secret-free JSON line to `.skanvil-feedback.jsonl`:

```json
{
  "timestamp": "2026-11-25T09:15:00Z",
  "skill": "back-migrations",
  "step": "3",
  "symptom": "npm run db:lint requires --workspace=api in monorepos",
  "proposedFix": "Document --workspace flag in Step 3 and Error Recovery table.",
  "suggestedEvalCase": {
    "id": "monorepo-workspace-lint",
    "prompt": "Check this migration in apps/api",
    "expected": ["Runs db:lint scoped to the api workspace without failing on root config."]
  }
}
```

Maintainers can inspect grouped reports and promote `suggestedEvalCase` entries directly into `evals.json`:

```bash
skanvil feedback list
skanvil feedback promote --dry-run
skanvil feedback promote --prune
```

`feedback list` groups matching `(skill, step, symptom)` reports and preserves malformed lines safely. `feedback promote` validates each case against `evals.json` / `params.json` schemas, avoids duplicate IDs or prompts, and with `--prune` removes promoted lines from `.skanvil-feedback.jsonl` after updating `SKILL.md` regressions.

---

## 6. Recommended CI workflow & PR diff checks

Compare pull requests against the base branch cleanly:

```bash
skanvil diff origin/main --format markdown
```

`skanvil diff` reports added/modified/removed skills, Stage-1 `alwaysLoadedTokens` deltas, `params.json` diffs, newly introduced validation issues, and offline trigger routing regressions.

```yaml
name: skills-quality
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx skanvil validate --strict --format github
      - run: npx skanvil index --check
      - run: npx skanvil eval triggers --strict
```
