# skanvil reference

## Commands

Every command accepts `-C, --cwd <path>` (library root) and `--json`. Exit code `0` means success; `1` means an error or failed check.

| Command                | Options                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [dir]`           | `--name`, `--scope`, `--description`, `--profile front,back,transversal`, `--no-git`, `--eject-templates`, `--no-agent-skill`, `--target <preset\|path>`                                                                                                               |
| `add`                  | `--type <category>`, `--name`, `--title`, `--description`, `--template <name>`, `--no-assets`, `--no-references`, `--no-scripts`, `--skip-validate`                                                                                                                    |
| `edit <skill>`         | `--rename`, `--type`, `--title`, `--description`, `--remove`, `--yes`, `--skip-validate`                                                                                                                                                                               |
| `list`                 | `--category <id>`                                                                                                                                                                                                                                                      |
| `validate`             | `--strict`, `--skill <name>`                                                                                                                                                                                                                                           |
| `index`                | `--check`                                                                                                                                                                                                                                                              |
| `doctor`               | `--fix`                                                                                                                                                                                                                                                                |
| `templates eject`      | `--category <id>`, `--force`                                                                                                                                                                                                                                           |
| `sync [dest]`          | `--target <preset\|path>` (repeatable/comma-separated, must stay inside dest), `--from <pkg\|path>`, `--link`, `--copy`, `--category`, `--skill`, `--force`, `--dry-run`, `--global` (presets only, no dest), `--param name=value` (repeatable, remembered per target) |
| `build`                | `--out <dir>`, `--force`                                                                                                                                                                                                                                               |
| `install-skill [dest]` | `--target <preset\|path>`, `--force`, `--global` (presets only, no dest)                                                                                                                                                                                               |

## `.skanvilrc.json`

```jsonc
{
  "$schema": "./node_modules/skanvil/schema.json",
  "name": "my-skills",
  "skillsDir": "skills", // default
  "readme": "README.md", // default
  "categories": [
    {
      "id": "front", // used by --type
      "prefix": "front-", // "" (default category only), "_" or kebab-case ending in "-"
      "title": "Front", // README section title
      "aliases": ["frontend", "f"],
      "default": false, // exactly one category is the default (empty prefix)
      "indexed": true, // listed in the README
      "validated": true, // validated against the spec and syncable
      "metadata": { "domain": "frontend" },
      "compatibility": "Designed for frontend repositories."
    }
  ],
  "validation": {
    "requiredSections": [
      "Objective",
      "When to Activate This Skill",
      "Instructions",
      "Output Format",
      "Quality Criteria"
    ],
    "placeholders": ["TODO", "describe...", "lorem ipsum", "tbd", "to be defined"],
    "maxLines": 500,
    "rules": { "max-lines": "warn" } // error | warn | off per rule id
  },
  "templates": { "dir": ".skanvil/templates" },
  "sync": { "targets": ["claude"], "mode": "copy" }
}
```

## Validation rules

Default severity is `error` unless noted. Rules marked with `*` are fixable by `doctor --fix`.

- **Files and YAML:** `skill-file`, `frontmatter`, `frontmatter-tabs`*.
- **Names:**
  - `folder-name`;
  - `name-required`*;
  - `name-format`: 1–64 characters of `a-z0-9-`, with no leading, trailing or double hyphens;
  - `name-matches-folder`*;
  - `duplicate-name`.
- **Spec fields:**
  - `description-required`;
  - `description-length` (≤ 1024);
  - `compatibility-length` (1–500);
  - `metadata-format` (warn);
  - `allowed-tools-format` (warn);
  - `tools-field`* (warn).
- **Content:** `required-sections`, `placeholders`, `max-lines` (warn), `broken-references`, `template-unchanged` (warn).
- **README:** `readme-missing`_, `readme-orphan`_, `readme-section`*.

## JSON output shapes

- `list --json` prints `[{ name, type, indexed, valid, description }]`. `indexed` and `valid` are `null` for categories that are not indexed or not validated.
- `validate --json` prints `{ ok, diagnostics: [{ rule, severity, skill?, message, fixable? }], count, errors, warnings }`.
- `doctor --json` prints the same as validate, plus `fixes: string[]`.
- `index --json` prints `{ updated }`, or `{ upToDate }` with `--check`.
- `sync --json` prints `{ dryRun, mode, results: [{ target, path, added, updated, unchanged, removed, skipped: [{ skill, reason }], warnings }] }`.
- `add --json` prints `{ skillName, title, type, target, template }`.
- `edit --json` prints `{ skillName, previousName }`, or `{ removed }`.

## Parameters (`params.json`)

```json
{
  "ticketTracker": { "type": "enum", "values": ["github", "jira"], "default": "github", "description": "…" },
  "packageManager": { "type": "string", "default": "npm" },
  "strict": { "type": "boolean", "default": false }
}
```

The syntax inside `SKILL.md`:

- `{{name}}` inserts the value;
- `{{#if name}}`, `{{#if !name}}`, `{{#if name == "v"}}` and `{{#if name != "v"}}` start a block;
- `{{else}}` and `{{/if}}` continue and close it.

A tag alone on its line removes the line.

What the build generates (`skanvil build`):

- `dist/index.mjs` and `index.cjs`, plus their `.d.mts` and `.d.cts` declarations;
- one export per skill, `<camelName>(params?) => string`;
- `skills`, an array with `{ name, category, title, description, params, render(params), files(params) }` for each skill;
- `getSkill(name)`.

## Template variables

The following variables are available in custom templates. In the `SKILL.md` frontmatter they are YAML-escaped automatically.

- `{{name}}`, `{{title}}`, `{{description}}`, `{{descriptionLower}}`;
- `{{category}}`, `{{domain}}`, `{{compatibility}}`;
- `{{resources}}`;
- `{{metadata.<key>}}`.
