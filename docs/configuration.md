# Configuration (`.skanvilrc.json`)

Each library is configured by a `.skanvilrc.json` file in its root.

- Every field is optional.
- A missing file uses the default preset: categories `front-`, `back-`, transversal and `_internal`.
- Unknown fields are rejected, so typos fail loudly.

Add the schema reference for completion and inline docs in your editor:

```json
{ "$schema": "./node_modules/skanvil/schema.json" }
```

## Top-level fields

| Field                         | Type                                       | Default                                                      | Description                                                   |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `name`                        | string                                     | —                                                            | Library name (informational).                                 |
| `scope`                       | string                                     | —                                                            | npm scope without `@` (informational).                        |
| `skillsDir`                   | string                                     | `"skills"`                                                   | Folder holding the skills.                                    |
| `readme`                      | string                                     | `"README.md"`                                                | File holding the skills index.                                |
| `categories`                  | Category[]                                 | default preset                                               | Replaces the default preset entirely when set.                |
| `validation.requiredSections` | string[]                                   | 5 sections, see below                                        | `## Headings` every SKILL.md must contain (case-insensitive). |
| `validation.placeholders`     | string[]                                   | `TODO`, `describe...`, `lorem ipsum`, `tbd`, `to be defined` | Forbidden text.                                               |
| `validation.maxLines`         | number                                     | `500`                                                        | Limit used by the `max-lines` rule.                           |
| `validation.rules`            | `{ [ruleId]: "error" \| "warn" \| "off" }` | `{}`                                                         | Severity overrides, see [Validation](validation.md).          |
| `templates.dir`               | string                                     | `".skanvil/templates"`                                       | Folder with custom templates, see [Templates](templates.md).  |
| `sync.targets`                | string[]                                   | `[]` (falls back to `claude`)                                | Default targets of `skanvil sync`.                            |
| `sync.mode`                   | `"copy"` \| `"link"`                       | `"copy"`                                                     | Default sync mode.                                            |

The default required sections are `Objective`, `When to Activate This Skill`, `Instructions`, `Output Format` and `Quality Criteria`.

## Categories

A category groups skills. It decides three things:

- the **folder prefix** of its skills;
- the **README section** where they are listed;
- the **frontmatter defaults** written to new skills.

| Field           | Type                | Default                         | Description                                                                                                        |
| --------------- | ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`            | string (kebab-case) | required                        | Used by `--type`.                                                                                                  |
| `prefix`        | string              | `""`                            | `""`, `"_"`, or kebab-case ending in `-` (`mobile-`, `data-ml-`).                                                  |
| `title`         | string              | title-cased `id`                | README section title.                                                                                              |
| `aliases`       | string[]            | `[]`                            | Other names accepted by `--type`.                                                                                  |
| `default`       | boolean             | `true` when the prefix is empty | Fallback category for folders without a known prefix.                                                              |
| `indexed`       | boolean             | `true`                          | List in the README index.                                                                                          |
| `validated`     | boolean             | `true`                          | Validate against the spec, and allow `sync`.                                                                       |
| `metadata`      | `{ [key]: string }` | `{}`                            | Written to the `metadata` map of new or re-categorised skills, and available as `{{metadata.<key>}}` in templates. |
| `compatibility` | string (max 500)    | —                               | Written to the `compatibility` field of new or re-categorised skills.                                              |

**How folders map to categories:** the folder belongs to the category whose prefix matches the start of its name. If nothing matches, it belongs to the default category. With prefixes `front-` and `back-`, `front-a11y` is front and `a11y` is the default category.

**Constraints, checked when the config is loaded:**

- Exactly one category has `default: true`, and it has an empty prefix. Every other category has a prefix.
- No prefix may start with another prefix (`data-` and `data-ml-` are ambiguous).
- Ids and aliases are unique across categories.
- Indexed categories have unique titles.

**Changing categories later:** to move an existing skill, use `skanvil edit <skill> --type <new>`, which renames the folder and moves the README entry. After renaming a category title by hand, run `skanvil index` to rebuild the README sections.

## The default preset

Used when `categories` is omitted. `init` writes it out in full so you can edit it:

```json
"categories": [
  { "id": "front", "prefix": "front-", "title": "Front", "aliases": ["frontend", "f"],
    "metadata": { "domain": "frontend" },
    "compatibility": "Designed for skills-compatible coding agents in frontend repositories." },
  { "id": "back", "prefix": "back-", "title": "Backend", "aliases": ["backend", "b"],
    "metadata": { "domain": "backend" },
    "compatibility": "Designed for skills-compatible coding agents in backend repositories." },
  { "id": "transversal", "prefix": "", "title": "Transversal", "default": true,
    "aliases": ["transverse", "shared", "common", "t"], "metadata": { "domain": "transversal" },
    "compatibility": "Designed for skills-compatible coding agents in shared or cross-functional repositories." },
  { "id": "internal", "prefix": "_", "title": "Internal", "indexed": false, "validated": false,
    "aliases": ["private", "i"], "metadata": { "domain": "internal" },
    "compatibility": "Designed for maintainers of this repository and internal workflow automation." }
]
```

Internal skills (`_name`) live next to the others but are neither listed, validated nor synced. Their names are not spec-compliant, because the spec forbids `_`. Use them for skills that only help maintain the library itself.

## Examples

### Product areas

```json
{
  "$schema": "./node_modules/skanvil/schema.json",
  "categories": [
    { "id": "mobile", "prefix": "mobile-", "aliases": ["app"], "metadata": { "domain": "mobile", "team": "apps" } },
    { "id": "data", "prefix": "data-", "title": "Data & ML", "aliases": ["ml"] },
    { "id": "general", "default": true }
  ],
  "sync": { "targets": ["claude", "copilot"] }
}
```

`skanvil add --type ml --name "Feature store"` creates `data-feature-store`, listed under **Data & ML**.

### A flat library

A single category means no prefixes and one README section:

```json
{
  "categories": [{ "id": "skill", "title": "Skills", "default": true }]
}
```

### Looser rules for a draft library

```json
{
  "validation": {
    "requiredSections": ["Instructions"],
    "placeholders": ["TODO"],
    "rules": { "max-lines": "off", "metadata-format": "off", "tools-field": "error" }
  }
}
```
