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

Use this skill when the user requests work related to {{descriptionLower}}

## Instructions

1. Confirm the relevant scope, files, and expected output with the user request.
2. Inspect the existing implementation or documentation before proposing changes.
3. Apply focused changes that preserve repository conventions and public behavior unless a change is explicitly required.
4. Run the narrowest useful validation and repair any issues introduced by the change.
5. Return a concise summary with files touched, validation results, and follow-up risks.

{{resources}}

## Output Format

- Summary of what was changed and why.
- List of modified files.
- Validation results.
- Risks or follow-up actions.

## Quality Criteria

- Steps are actionable and unambiguous.
- Output is reproducible and easy to verify.
- File references are explicit and relevant.
