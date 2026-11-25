---
name: {{name}}
description: {{description}}
compatibility: {{compatibility}}
metadata:
  domain: {{domain}}
  version: "1.0"
# allowed-tools: Read Grep Glob   (optional, experimental: space-separated pre-approved tools)
---

# {{title}}

## Objective

Provide a repeatable {{domain}} workflow for {{descriptionLower}}

## When to Activate This Skill

- Use this skill when the user requests work related to {{descriptionLower}}
- Do not activate this skill when the request is unrelated to {{descriptionLower}}

## Instructions

1. Confirm the relevant scope, target files, and expected output against the user request.
2. Inspect the existing implementation or documentation and confirm the facts before making edits.
3. Apply focused changes that preserve repository conventions and public behavior unless a change is explicitly required.
4. Run the narrowest useful validation and verify every check exits cleanly before proceeding.
5. Return a concise summary with files touched, validation results, and follow-up risks.

{{resources}}

## Error Recovery

| Failure | Cause | Recovery Action |
| --- | --- | --- |
| Expected command or check fails | Missing prerequisites or unexpected repository state | Inspect the error output, verify prerequisites, and report the blocking issue before proceeding. |

## Output Format

- Summary of what was changed and why.
- List of modified files.
- Validation results.
- Risks or follow-up actions.

## Quality Criteria

- Steps are actionable and unambiguous.
- Output is reproducible and easy to verify.
- File references are explicit and relevant.
