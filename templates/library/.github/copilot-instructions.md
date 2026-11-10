# {{title}} - Agent Instructions

## Project Purpose

This repository is a library of reusable Agent Skills.

- `skills/`: skill folders (each one must contain `SKILL.md`)
- `README.md`: index of every public skill
- `.skanvilrc.json`: categories (folder prefixes, README sections), validation rules, templates and sync targets

## Mandatory Skill Conventions

1. Folder naming: each category in `.skanvilrc.json` defines a folder prefix (for example `front-`, `back-`, or `_` for internal skills that are neither indexed nor validated). The default category has no prefix. Names are strict kebab-case.
2. Frontmatter: `name` and `description` are required; `name` must match the folder name. Follow https://agentskills.io/specification (name ≤ 64 chars, description ≤ 1024 chars, optional `compatibility`, `metadata`, `allowed-tools`).
3. Required body sections (level 2 headers) are listed in `.skanvilrc.json` > `validation.requiredSections`.
4. Avoid placeholders such as `TODO`, `lorem ipsum`, `tbd`. Keep `SKILL.md` under 500 lines and move long details to `references/`.
5. Every public skill must be listed in `README.md` under the section of its category.

## Workflow

- Load the `skanvil` skill (`.claude/skills/skanvil/SKILL.md`, installed by `skanvil init`; refresh it with `npx skanvil install-skill`) before changing skills: it explains every command and how to fix validation errors.
- Create skills with `npx skanvil add` and modify them with `npx skanvil edit` (never rename folders by hand).
- Run `npm test` (`skanvil validate --strict && skanvil index --check`) before committing; `npx skanvil doctor --fix` repairs most issues.
- Keep diffs focused and commit by concern (`feat:`, `fix:`, `refactor:`, `docs:`).
