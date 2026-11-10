# Validation

`skanvil validate` checks three things:

- every skill, against the [Agent Skills specification](https://agentskills.io/specification);
- the conventions configured for the library;
- the consistency of the README index.

It also runs automatically after `add` and `edit`.

**Which skills are checked:**

- Skills of categories with `validated: false` (the default `_internal`) are skipped.
- README checks only consider categories with `indexed: true`.

## Rules

| Rule                   | Default | Fixable | Checks                                                                                                       |
| ---------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `skill-file`           | error   |         | Each skill folder contains `SKILL.md`.                                                                       |
| `frontmatter`          | error   |         | `SKILL.md` starts with valid YAML frontmatter between `---` delimiters, and it is a mapping.                 |
| `frontmatter-tabs`     | error   | ✓       | No tab characters in the frontmatter.                                                                        |
| `folder-name`          | error   |         | The folder name is strict kebab-case (`_` allowed as the internal prefix).                                   |
| `name-required`        | error   | ✓       | Frontmatter `name` is present.                                                                               |
| `name-format`          | error   |         | Spec: `name` is 1–64 characters of `a-z`, `0-9` and single hyphens, and does not start or end with a hyphen. |
| `name-matches-folder`  | error   | ✓       | `name` equals the folder name.                                                                               |
| `duplicate-name`       | error   |         | No two skills share a frontmatter `name`.                                                                    |
| `description-required` | error   |         | Frontmatter `description` is present.                                                                        |
| `description-length`   | error   |         | Spec: `description` is at most 1024 characters.                                                              |
| `compatibility-length` | error   |         | Spec: `compatibility`, when present, is 1–500 characters.                                                    |
| `metadata-format`      | warn    |         | Spec: `metadata` maps string keys to string values. Quote numbers: `version: "1.0"`.                         |
| `allowed-tools-format` | warn    |         | Spec: `allowed-tools` is a space-separated string.                                                           |
| `tools-field`          | warn    | ✓       | `tools` is not a spec field. Use `allowed-tools`.                                                            |
| `required-sections`    | error   |         | The body contains every heading in `validation.requiredSections`.                                            |
| `placeholders`         | error   |         | The file contains none of `validation.placeholders`.                                                         |
| `max-lines`            | warn    |         | `SKILL.md` is at most `validation.maxLines` lines (spec recommendation: 500).                                |
| `broken-references`    | error   |         | Relative links and `references/`, `scripts/`, `assets/` paths in `SKILL.md` exist inside the skill folder.   |
| `template-unchanged`   | warn    |         | The body no longer contains the generic sentences of the built-in skill template.                            |
| `readme-missing`       | error   | ✓       | Every indexed skill is listed in the README.                                                                 |
| `readme-orphan`        | error   | ✓       | The README does not list skills that don't exist.                                                            |
| `readme-section`       | error   | ✓       | Skills are listed under their own category's section.                                                        |

**Placeholder matching:**

- ALL-CAPS placeholders such as `TODO` match case-sensitively as whole words. `TODO:` and `(TODO)` match; `TODOS` and `todo` do not.
- Other placeholders match case-insensitively at word boundaries.

**Reference checking (`broken-references`):**

- Checked: relative Markdown link targets such as `[guide](references/guide.md)`, and backticked paths such as `` `scripts/run.sh` ``.
- Anchors and query strings are ignored, so `references/guide.md#usage` checks `references/guide.md`.
- Not checked: URLs, `mailto:`, `#anchors`, absolute paths, fenced code blocks, and patterns such as `scripts/<name>.sh` or `assets/*.png`.
- Links that leave the skill folder (`../other/SKILL.md`) are reported, because the spec keeps references inside the skill, one level deep.

**Scaffold text (`template-unchanged`):** `skanvil add` copies generic instructions from the built-in template. They read fine but say nothing specific, so the rule warns until they are replaced. In libraries that run `validate --strict`, as the generated `npm test` does, a new skill fails CI until real content is written.

## Tuning severities

Override any rule per library in `.skanvilrc.json`:

```json
{
  "validation": {
    "rules": {
      "max-lines": "off",
      "tools-field": "error",
      "metadata-format": "warn"
    }
  }
}
```

Severities and exit codes:

- `error` makes `validate` exit with 1.
- `warn` is reported, and fails only with `--strict`.
- `off` disables the rule.

## Fixing problems

```bash
skanvil doctor          # list problems; fixable ones are marked
skanvil doctor --fix    # repair them, then re-validate
skanvil index           # regenerate the README index from scratch
```

Notes on `doctor --fix`:

- It only edits what it can change safely. Missing sections, placeholders and over-long descriptions still need a human.
- Converting `tools` to `allowed-tools` keeps the tool names as they were. Those names are often agent-specific (for example VS Code's `read_file`), so review them after the conversion.

## JSON output

```bash
skanvil validate --json
```

```json
{
  "ok": false,
  "diagnostics": [
    {
      "rule": "placeholders",
      "severity": "error",
      "skill": "front-api-review",
      "message": "contains a forbidden placeholder (\"TODO\")"
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

`skill` is absent for library-level diagnostics.

## CI

Generated libraries already contain `.github/workflows/skills.yml`. For other setups:

```yaml
- run: npm ci
- run: npx skanvil validate --strict
- run: npx skanvil index --check
```

To validate a single skill while you write it:

```bash
skanvil validate --skill front-api-review
```
