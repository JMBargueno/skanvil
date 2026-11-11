# Copilot instructions

Follow [AGENTS.md](../AGENTS.md) at the repository root: it holds the project overview, commands,
code boundaries, rules, and commit and release conventions for skanvil.

The essentials:

- Before finishing, run `npm run lint`, `npm run format:check`, `npm run typecheck`,
  `npm run build` and `npm test`.
- Core logic lives in `src/core/`, which never prints or exits. CLI handlers in `src/commands/` are
  thin.
- Every behaviour change needs tests, plus JSDoc on exports, plus updates to `docs/` and to the
  `agent-skill/skanvil/` skill when it is user-facing.
- Keep `renderTemplate` and `resolveParamValues` self-contained, because `skanvil build` embeds
  their source.
- Use Conventional Commits, since they drive releases. Never edit the version, `CHANGELOG.md` or
  tags by hand.
