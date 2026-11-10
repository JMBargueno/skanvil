# Programmatic API

Everything the CLI does is available from Node.js:

```ts
import { Library, scaffoldSkill } from "skanvil";
```

The package is ESM-only. Every export has TypeScript types and JSDoc, so your editor shows signatures, options, defaults and thrown errors on hover.

Core functions never print and never call `process.exit`. They return data or throw `Error`s with readable messages.

## Opening a library

```ts
import { Library } from "skanvil";

const lib = await Library.open("./my-skills"); // throws if there is no skills/ folder
lib.config.categories; // resolved .skanvilrc.json
lib.categories.fromFolder("front-x").id; // "front"
await lib.listSkillFolders(); // ["back-y", "front-x", ...]

const skill = await lib.readSkill("front-x"); // SkillFile
skill.getString("description");
```

Functions that take a library also accept a root path (`scaffoldSkill("./my-skills", …)`). Pass a `Library` instance when making several calls, so the config is loaded once.

## Creating libraries and skills

```ts
import { createLibrary, scaffoldSkill, editSkill, removeSkill } from "skanvil";

await createLibrary("./my-skills", { scope: "acme", git: false });

const { skillName } = await scaffoldSkill("./my-skills", {
  type: "front",
  name: "API review",
  description: "Reviews API integration changes",
  includeScripts: false
}); // "front-api-review"

await editSkill("./my-skills", skillName, { rename: "http-review", type: "back" });
await removeSkill("./my-skills", "back-http-review");
```

`editSkill` is transactional: if it fails, `SKILL.md` and the README are restored and the error message starts with `Edit failed and was rolled back`.

## Validating

```ts
import { Library, validateLibrary, formatDiagnostic, RULES } from "skanvil";

const result = await validateLibrary(await Library.open("."));
for (const d of result.diagnostics) {
  console.log(d.severity, formatDiagnostic(d), `[${d.rule}]`, RULES[d.rule].description);
}
process.exitCode = result.errors > 0 ? 1 : 0;
```

`ValidationResult` is `{ diagnostics, count, errors, warnings }`. Each `Diagnostic` is `{ rule, severity, skill?, message, fixable? }`.

## Maintaining the README index

```ts
import { Library, rebuildIndex, reconcileIndex, doctor } from "skanvil";

const lib = await Library.open(".");
const readme = await lib.readReadme(); // { text (LF), eol }

const rebuilt = await rebuildIndex(lib, readme.text); // full regeneration
if (rebuilt !== readme.text) await lib.writeReadme({ ...readme, text: rebuilt });

const { text, changes } = await reconcileIndex(lib, readme.text); // minimal repair

const { fixes, after } = await doctor(lib, { fix: true }); // everything fixable
```

## Syncing

```ts
import { Library, syncSkills, TARGET_PRESETS } from "skanvil";

const results = await syncSkills(await Library.open("./my-skills"), {
  dest: "../my-app",
  targets: ["claude", "copilot"],
  mode: "copy",
  dryRun: true
});
for (const r of results) console.log(r.target, r.added, r.updated, r.removed, r.skipped);
```

## Editing SKILL.md files directly

```ts
import { SkillFile } from "skanvil";
import fs from "node:fs/promises";

const file = "skills/front-x/SKILL.md";
const skill = SkillFile.parse(await fs.readFile(file, "utf8"));
skill.set(["metadata", "owner"], "web-platform");
skill.setTitle("Front X");
await fs.writeFile(file, skill.toString()); // comments, quoting and CRLF are preserved
```

## Configuration helpers

```ts
import { resolveConfig, loadConfig, configJsonSchema, DEFAULT_CATEGORIES } from "skanvil";

const config = resolveConfig({ categories: [{ id: "general", default: true }] }); // throws on invalid input
const fromDisk = await loadConfig("./my-skills");
const schema = configJsonSchema(); // same as skanvil/schema.json
```

## Export overview

| Export                                                                                                 | Kind               | Purpose                                                |
| ------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------ |
| `Library`                                                                                              | class              | Open a library; paths, skills and README I/O.          |
| `Categories`                                                                                           | class              | Category lookup, prefix inference, name building.      |
| `SkillFile`                                                                                            | class              | Parse and edit a `SKILL.md` without losing formatting. |
| `createLibrary`, `parseProfile`                                                                        | functions          | `skanvil init`.                                        |
| `scaffoldSkill`, `editSkill`, `removeSkill`                                                            | functions          | `skanvil add` / `edit`.                                |
| `collectSkills`                                                                                        | function           | `skanvil list` rows.                                   |
| `validateLibrary`, `formatDiagnostic`, `RULES`                                                         | functions / const  | `skanvil validate`.                                    |
| `rebuildIndex`, `reconcileIndex`, `doctor`                                                             | functions          | `skanvil index` / `doctor`.                            |
| `resolveSkillTemplate`, `ejectSkillTemplate`                                                           | functions          | Templates.                                             |
| `syncSkills`, `resolveTarget`, `TARGET_PRESETS`, `MANIFEST_FILE`                                       | functions / consts | `skanvil sync`.                                        |
| `installAgentSkill`, `agentSkillSource`, `AGENT_SKILL_NAME`                                            | functions / const  | `skanvil install-skill`.                               |
| `resolveConfig`, `loadConfig`, `ConfigSchema`, `configJsonSchema`, `DEFAULT_CATEGORIES`, `CONFIG_FILE` | functions / consts | Configuration.                                         |
