# Templates

`skanvil add` creates a skill by copying a template folder. The built-in template contains:

- `SKILL.md`, with every required section;
- `references/REFERENCE.md`;
- `scripts/example-helper.js`;
- `assets/output-template.md`.

You can replace it per library, per category or per call.

## Lookup order

`skanvil add` uses the first folder that exists. Whole folders are used; files are not merged from several levels.

1. `<templates.dir>/<name>`, when `--template <name>` is given. If the folder is missing, `add` fails.
2. `<templates.dir>/skill-<category-id>`, for example `.skanvil/templates/skill-back`.
3. `<templates.dir>/skill`.
4. The built-in template shipped with skanvil.

`templates.dir` defaults to `.skanvil/templates` (see [Configuration](configuration.md)).

## Ejecting the built-in template

```bash
skanvil templates eject                    # -> .skanvil/templates/skill (all categories)
skanvil templates eject --category back    # -> .skanvil/templates/skill-back
skanvil init my-skills --eject-templates   # eject while creating the library
```

The files are copied unrendered, so placeholders stay in place. Edit them freely and commit them with the library.

## Variables

Placeholders use `{{name}}` syntax. Unknown placeholders are left untouched.

| Variable               | Example                | Notes                                                                             |
| ---------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `{{name}}`             | `front-api-review`     | Folder and frontmatter name.                                                      |
| `{{title}}`            | `Api Review`           | From `--title`, or derived from the name.                                         |
| `{{description}}`      | `Reviews API changes.` | Always ends with a period.                                                        |
| `{{descriptionLower}}` | `reviews API changes.` | First letter lower-cased, to use inside a sentence.                               |
| `{{category}}`         | `front`                | Category id.                                                                      |
| `{{domain}}`           | `frontend`             | `metadata.domain` of the category, or the category id.                            |
| `{{compatibility}}`    | `Designed for …`       | Category `compatibility`, or empty.                                               |
| `{{resources}}`        | bullet list            | Mentions `references/`, `scripts/` and `assets/` depending on the `--no-*` flags. |
| `{{metadata.<key>}}`   | `apps`                 | Any key of the category's `metadata`.                                             |

**Escaping:**

- Inside the `SKILL.md` frontmatter, values are YAML-escaped automatically. A description like `Handles: retries #2` is quoted, so the frontmatter stays valid.
- In the body and in other files, values are inserted as-is.

**Files:**

- Text files (`.md`, `.json`, `.yaml`, `.js`, `.ts`, `.py`, `.sh`, `.txt`, and files without extension) are rendered. Everything else is copied byte for byte.
- A file named `gitignore` becomes `.gitignore`, because npm never publishes files named `.gitignore`.

## After rendering

Once the template is copied, `add` applies the category to the frontmatter:

- every `metadata` entry of the category is set;
- `compatibility` is set when the category has one. An empty `compatibility` is removed, because the spec requires 1–500 characters.

Comments and formatting in the rest of the frontmatter are kept.

## Tips

- Keep the required sections from `validation.requiredSections` in your template, otherwise every new skill fails validation.
- Don't leave placeholder text such as `TODO` in templates. Use instructions that read correctly as written.
- If a category never needs scripts, delete `scripts/` from its template instead of passing `--no-scripts` every time.
- Use `--template` for one-off shapes, such as a `.skanvil/templates/checklist` for checklist-style skills.
