# Getting started

This guide creates a skills library, adds and edits skills, checks them in CI, publishes the library and installs its skills into an application repository.

> **Prefer menus?** Run `npx skanvil` without arguments in a terminal. The [wizard](commands.md#wizard) walks through every step below. After each action it prints the equivalent command, which is the one this guide uses.

## 0. Let your AI agent learn skanvil (optional)

skanvil ships an agent skill that teaches coding agents (Claude Code, GitHub Copilot, Codex…) how to use it:

- the commands and the rules (never rename folders or edit the README index by hand);
- how to fix every validation error;
- how to write good skill content.

Paste this prompt into your agent, inside the repository where you want to work. That can be an existing skills library, an application that consumes one, or an empty folder for a new library.

```text
Install and learn the skanvil agent skill in this repository.

1. Work out which skills folder you read: Claude Code uses .claude/skills, GitHub Copilot
   .github/skills, Codex .agents/skills. Then run the matching command, for example:
     npx skanvil@latest install-skill --target claude
   Use --target copilot or --target agents (comma-separated for several) if that fits you
   better. Do not use --global unless I ask for it.
2. Read the installed <skills folder>/skanvil/SKILL.md completely (for example
   .claude/skills/skanvil/SKILL.md), and then its references/REFERENCE.md.
3. Detect the context:
   - if there is a .skanvilrc.json, run `npx skanvil list --json` and `npx skanvil validate --json`;
   - otherwise, tell me this is not a skills library yet.
4. Reply with:
   - a short summary of how you will use skanvil here;
   - the golden rules you will follow;
   - what the library contains and any validation problems you found.
   Do not change any skill until I ask.

From now on, whenever I ask you to create, rename, move, delete, validate, parametrize, build or
install skills, use the skanvil skill and its commands. Do not edit skill folders or the README
index by hand, always pass every option (the commands are interactive otherwise), and never run
`skanvil` without arguments, because that opens a menu meant for humans.
```

After that, you can ask in plain language, and the agent will turn each request into the right commands. For example:

- _"Create a skills library called acme-skills with categories mobile and data."_
- _"Add a backend skill for zero-downtime database migrations and write its content."_
- _"Make the code-review skill configurable for GitHub or Jira."_
- _"Install the library's skills into ../my-app for Claude Code and Copilot."_

The agent will then run `init`, `add`, `edit`, `validate`, `sync --param`, `build` and so on, and check the result with `skanvil validate`.

`skanvil init` already installs this skill in new libraries, in `.claude/skills/skanvil` by default. Run the prompt again after upgrading skanvil, and `install-skill` will refresh the skill.

## 1. Create a library

```bash
npx skanvil init my-skills --scope acme --description "Acme's shared coding-agent skills."
cd my-skills
npm install
```

`init` creates:

```text
my-skills/
├── .claude/skills/skanvil/       # the skanvil agent skill: teaches agents this workflow
├── .github/
│   ├── copilot-instructions.md   # tells agents how to work in this repo
│   └── workflows/skills.yml      # CI: validate + index check
├── skills/                       # empty, ready for skills
├── .skanvilrc.json               # categories, rules, sync targets
├── AGENTS.md
├── ARCHITECTURE.md
├── README.md                     # contains the skills index
└── package.json                  # @acme/my-skills, with skanvil scripts
```

The `skanvil` agent skill lets you delegate the work to an agent. Ask Claude Code or Copilot to "add a backend skill for database migrations" and the agent will run `skanvil add`, write the content and validate it, without creating folders by hand. Use `--no-agent-skill` to skip it, or `skanvil install-skill --target copilot,agents` to add it for more agents.

Useful `init` options:

- `--profile front,back` creates only some README sections of the default preset.
- `--no-git` skips `git init`.
- `--eject-templates` copies the skill template so you can customise it straight away (see [Templates](templates.md)).

If the default categories (`front-`, `back-`, transversal, `_internal`) don't fit your team, edit `.skanvilrc.json` now, before adding skills. See [Configuration](configuration.md).

## 2. Add a skill

```bash
npx skanvil add --type front --name "API review" \
  --description "Reviews API integration changes for error handling, typing and retries."
```

This:

1. builds the folder name `front-api-review`, using the category prefix and the kebab-cased name;
2. copies the skill template into `skills/front-api-review/`, filling in name, title, description and category metadata;
3. adds an entry under **Front** in `README.md`;
4. validates the library.

Run `npx skanvil add` with no options in a terminal to be prompted for the category, name, title and description.

Then write the actual instructions. Open `skills/front-api-review/SKILL.md`, replace the generic steps, and move long material into `references/`. The default required sections are `Objective`, `When to Activate This Skill`, `Instructions`, `Output Format` and `Quality Criteria`.

## 3. Rename, re-categorise, delete

```bash
npx skanvil edit front-api-review --rename http-review        # front-http-review
npx skanvil edit front-http-review --type back                # back-http-review, moved to "Backend"
npx skanvil edit back-http-review --title "HTTP Review" --description "Reviews HTTP clients."
npx skanvil edit back-http-review --remove                    # asks for confirmation (--yes to skip)
```

`edit` keeps the folder, the frontmatter `name`, the `# heading` and the README entry consistent. If something fails halfway, it rolls the files back. Never rename skill folders by hand. If you already did, run `npx skanvil doctor --fix`.

## 4. Check the library

```bash
npx skanvil list               # overview
npx skanvil validate           # errors fail; warnings are reported
npx skanvil validate --strict  # warnings fail too
npx skanvil doctor --fix       # repair what can be repaired automatically
```

The generated `package.json` wires these into npm:

| Script                                            | Runs                                                 |
| ------------------------------------------------- | ---------------------------------------------------- |
| `npm test`                                        | `skanvil validate --strict && skanvil index --check` |
| `npm run prebuild`                                | `skanvil validate`                                   |
| `npm run skill:add` / `skill:edit` / `skill:list` | the matching command                                 |
| `npm run skill:doctor`                            | `skanvil doctor --fix`                               |
| `npm run skill:sync`                              | `skanvil sync`                                       |

The generated `.github/workflows/skills.yml` runs the same checks on every push and pull request. See [Validation](validation.md) for the rules.

## 5. Publish

A library is a normal npm package: `files` already includes `skills`, `README.md` and `.skanvilrc.json`.

```bash
npm version minor
npm publish --access restricted     # or push to your private registry
```

Publishing is optional. `sync` also works from a local folder or a git checkout.

## 6. Use the skills in an application

```bash
cd ../my-app
npm install --save-dev @acme/my-skills skanvil
npx skanvil sync --from @acme/my-skills --target claude,copilot
```

The skills are copied into `.claude/skills/` and `.github/skills/`, where Claude Code and GitHub Copilot discover them. Running the same command again:

- updates changed skills;
- removes skills that were deleted from the library;
- never touches skills it did not install.

See [Sync](sync.md) for link mode, filters and committing the result.

If agents in the application should also manage skills (for example, re-running the sync after an upgrade), install the skanvil agent skill there too:

```bash
npx skanvil install-skill --target claude,copilot
```

## Next steps

- [Configuration](configuration.md): define your own categories.
- [Templates](templates.md): give every new skill your house style.
- [API](api.md): automate with Node.js.
