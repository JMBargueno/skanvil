---
name: skanvil-feedback
description: Log structured friction reports when an Agent Skill fails, causes wasted tool loops, or gives outdated guidance. Use whenever executing a skill hits broken steps, missing prerequisites, or wrong instructions; do not use for normal application bugs.
metadata:
  author: skanvil
  version: "1.0"
---

# skanvil-feedback

## Objective

Capture concrete execution friction from Agent Skill sessions in `.skanvil-feedback.jsonl` so maintainers can fix stale instructions and turn real failures into regression cases in `evals.json`.

## When to Activate This Skill

- A synced or library `SKILL.md` leads to wrong commands, missing flags, broken paths, or repeated tool-call loops.
- Model or repository changes break a skill's documented workflow or error recovery table.
- Do not activate for ordinary application bugs unrelated to skill instructions, or to log secrets, credentials, or private user data.

## Instructions

1. Identify the exact skill folder name, the failing instruction step or section, the observed symptom, the number of extra turns wasted, and a concrete proposed fix. Verify that the summary contains no secrets, tokens, or sensitive paths.
2. Check whether `.skanvil-feedback.jsonl` already exists in the repository root and inspect recent entries so duplicate reports for the same root cause are avoided.
3. Build a single-line JSON object matching this schema and append it to `.skanvil-feedback.jsonl`:
   - `timestamp`: ISO-8601 UTC timestamp
   - `skill`: skill folder name (for example `front-api-review`)
   - `step`: step number or section heading where friction occurred
   - `symptom`: concise description of what failed or misled the agent
   - `proposedFix`: concrete change to `SKILL.md` or its resources
   - `suggestedEvalCase`: object with `id`, `prompt`, and `expected` suitable for `evals.json`
4. Verify the appended line is valid JSON by running `node -e "const fs = require('fs'); const lines = fs.readFileSync('.skanvil-feedback.jsonl', 'utf8').trim().split(/\r?\n/); JSON.parse(lines[lines.length - 1]); console.log('Entries:', lines.length);"` and confirming it exits `0`.
5. If the user asks to promote reports inside a skills library repository, suggest or run `npx skanvil feedback list` and `npx skanvil feedback promote --prune` so validated `suggestedEvalCase` items move straight into `evals.json`. If escalating upstream via `.skanvil-sync.json`, prepare a concise summary from the JSONL entry without modifying unrelated project files.

## Error Recovery

| Failure                                     | Cause                                                  | Recovery Action                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `.skanvil-feedback.jsonl` cannot be written | Read-only directory or sandboxed workspace path        | Present the single-line JSON report in the final response so the user can save or file it manually.                         |
| JSON parse verification fails               | Unescaped quotes or multi-line string inside the entry | Rewrite the last line using `JSON.stringify(entry)` via Node so escaping is exact, then re-run the parse check.             |
| Skill name is unknown                       | Skill was loaded without noting its folder name        | Inspect `.claude/skills/`, `.github/skills/`, or `.agents/skills/` for the matching `SKILL.md` `name` field before logging. |

## Output Format

Report to the user:

- the skill name and failing step logged;
- the path written (`.skanvil-feedback.jsonl`) and the JSON validation result;
- the proposed `SKILL.md` fix and `evals.json` regression case.

## Quality Criteria

- Each entry is one valid JSON line containing no secrets or PII.
- Every report names a specific skill, step, concrete symptom, and actionable fix.
- The `.skanvil-feedback.jsonl` parse verification command succeeded after writing.
