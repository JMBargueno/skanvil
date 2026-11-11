# Parameters and package exports

Two optional features turn a skills library into something other code can use.

- **Parameters** make one skill adapt to each team or project: the issue tracker, the package
  manager, a dashboard URL. You keep one skill instead of near-identical copies.
- **Exports** (`skanvil build`) make the library's npm package importable:
  `import { codeReview } from "@acme/skills"` returns the skill's `SKILL.md`, rendered with the
  parameters you pass. The result is fully typed.

Skills without parameters work exactly as before. You can use exports without ever adding a
parameter.

## When this is worth it

- **One skill, many variants.** Teams use different trackers, CI systems or package managers, and
  you are about to duplicate a skill to change a few lines.
- **Facts an agent cannot infer.** For example the Grafana URL, the incident Slack channel or the
  real deploy command. A parameter keeps them out of the shared text.
- **Skills consumed by code**, such as a project generator that installs tailored skills, a custom
  agent built with an SDK that puts a skill in its prompt, or a monorepo script that installs a
  skill per package.

If every project uses the same tools, plain `SKILL.md` files plus `skanvil sync` are simpler.

## Declaring parameters

Add a `params.json` next to the skill's `SKILL.md`:

```text
skills/front-code-review/
├── SKILL.md
├── params.json
└── references/
```

```json
{
  "ticketTracker": {
    "type": "enum",
    "values": ["github", "jira", "linear"],
    "default": "github",
    "description": "Where findings are filed"
  },
  "packageManager": { "type": "string", "default": "npm" },
  "strict": { "type": "boolean", "default": false, "description": "Block merges on any finding" }
}
```

Rules for `params.json`:

- **Names** are camelCase letters and digits.
- **Types** are `enum` (with `values`), `string` or `boolean`.
- **Defaults** are required, so a skill always renders. An enum default must be one of its values.
- **The file stays out of agents' folders.** `params.json` is not part of the Agent Skills spec, so
  `sync` and `build` never copy it to them.

## Template syntax

Use the parameters anywhere in `SKILL.md`, including the frontmatter:

```md
Run `{{packageManager}} test` before reviewing, and file each finding in {{ticketTracker}}.

{{#if ticketTracker == "jira"}}
Use the `PROJ-123` key format in the summary.
{{else}}
Reference issues as `#123`.
{{/if}}

{{#if strict}}
Block the merge until every finding is resolved.
{{/if}}
```

| Syntax                                                | Meaning                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `{{name}}`                                            | The parameter's value.                                                |
| `{{#if name}}` / `{{#if !name}}`                      | The parameter is true, or false. For strings, "true" means not empty. |
| `{{#if name == "value"}}` / `{{#if name != "value"}}` | Equality test (single or double quotes).                              |
| `{{else}}`, `{{/if}}`                                 | Else branch and end of block. Blocks can nest.                        |

How rendering behaves:

- **Tag lines vanish.** A block tag alone on its line removes the whole line, so blocks leave no
  blank lines behind.
- **Literal braces are safe.** `{{text}}` that is not a declared parameter is left as it is. In a
  skill that has a `params.json`, validation reports it, because it is usually a typo.

## Validation

`skanvil validate` checks parametrized skills as rendered with their defaults, so every spec and
library rule still applies. Two extra rules apply:

- **`params-file`**: `params.json` is valid.
- **`params-template`**: `{{…}}` references and `{{#if}}` blocks use declared parameters and are
  balanced.

Fix the defaults first: the README index and `skanvil list` show the description rendered with
them.

## Installing with values (`sync --param`)

```bash
npx skanvil sync --from @acme/skills --target claude \
  --param ticketTracker=jira --param packageManager=pnpm --param strict=true
```

What happens:

- **Rendering.** Every synced skill that declares a parameter gets that value. The others take
  their defaults. The installed `SKILL.md` is rendered and `params.json` is left out.
- **Typos fail early.** A name that no synced skill declares is an error, raised before anything
  is written.
- **Values are remembered per target**, in `.skanvil-sync.json`. A later `skanvil sync` without
  `--param` reuses them, and passing `--param` again replaces them.
- **No links.** A rendered skill cannot be linked, so `--link` copies parametrized skills (with a
  warning) and still links the others.

## Package exports (`skanvil build`)

```bash
npx skanvil build          # writes dist/index.mjs, index.cjs, index.d.mts, index.d.cts
```

Generated libraries already wire this up:

- `npm run build` runs `skanvil validate` and then `skanvil build`.
- `prepublishOnly` builds before every publish.
- `package.json` has `exports`, `main` and `types` pointing at `dist/`.
- `dist/` is gitignored.

The build refuses to run while validation reports errors, unless you pass `--force`.

For a library with `front-code-review` (with the parameters above) and `back-migrations`,
consumers get:

```ts
import { codeReview, migrations, skills, getSkill, type CodeReviewParams } from "@acme/skills";

codeReview(); // SKILL.md with the defaults
codeReview({ ticketTracker: "jira", strict: true }); // rendered for one team
codeReview({ ticketTracker: "trello" }); // type error, and a runtime error in plain JS

migrations(); // a skill without parameters: its SKILL.md as is

for (const skill of skills) console.log(skill.name, skill.category, skill.description);

// Every file of a skill (references, scripts, assets), with SKILL.md rendered:
const files = getSkill("front-code-review").files({ ticketTracker: "linear" });
// { "SKILL.md": { encoding: "utf8", content: "…" }, "references/REFERENCE.md": { … }, … }
```

How exports are named:

- **The default** is the folder name without its category prefix, in camelCase:
  `front-code-review` becomes `codeReview`.
- **Clashes** use the full folder name, for example `frontReview` and `backReview`.
- **Names that cannot be identifiers** get a `skill` prefix, for example `skill2faSetup`.
- **What is exported:** only publishable skills, meaning categories with `validated: true`.
  `_internal` skills are never exported.

The generated code has no dependencies, not even skanvil. It embeds the same renderer that
skanvil uses, so `codeReview({ … })` and `skanvil sync --param …` always produce the same text.

### Examples

**A project generator** writes tailored skills into a new service:

```ts
import fs from "node:fs";
import path from "node:path";
import { getSkill } from "@acme/skills";

function installSkill(name: string, params: Record<string, string | boolean>, root = ".claude/skills") {
  for (const [file, { encoding, content }] of Object.entries(getSkill(name as never).files(params as never))) {
    const target = path.join(root, name, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(content, encoding));
  }
}

installSkill("front-code-review", { ticketTracker: "jira", packageManager: "pnpm" });
```

**A custom agent** puts a skill in its system prompt:

```ts
import { codeReview } from "@acme/skills";

const system = codeReview({ ticketTracker: "github", strict: true });
// pass `system` to your Claude API / Agent SDK call
```

The skill is then versioned like any dependency, so Renovate or Dependabot tell you when it
changes.
