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

## Creating, importing and editing skills

```ts
import { createLibrary, scaffoldSkill, importSkills, editSkill, removeSkill } from "skanvil";

await createLibrary("./my-skills", { scope: "acme", git: false });

const { skillName } = await scaffoldSkill("./my-skills", {
  type: "front",
  name: "API review",
  description: "Reviews API integration changes"
}); // "front-api-review"

await importSkills("./my-skills", "../app/.claude/skills", { type: "front" });

await editSkill("./my-skills", skillName, {
  rename: "http-review",
  type: "back",
  owner: "@platform",
  status: "active"
});
await removeSkill("./my-skills", "back-http-review");
```

`editSkill` and `importSkills` are transactional: if a failure occurs mid-batch, modified files, folders and the README are restored cleanly.

## Measuring budgets, evals, feedback and diffs

```ts
import {
  Library,
  analyzeLibraryStats,
  checkTriggerRouting,
  routePrompt,
  exportEvalDataset,
  summarizeFeedback,
  promoteFeedback,
  diffLibrary,
  formatDiffMarkdown
} from "skanvil";

const lib = await Library.open("./my-skills");

const stats = await analyzeLibraryStats(lib, { sort: "tokens" });
console.log("Stage-1 tokens:", stats.totals.alwaysLoadedTokens);

const route = await routePrompt(lib, "Review React modal ARIA focus", { top: 3 });
const triggers = await checkTriggerRouting(lib, { split: "eval" });
const promptfoo = await exportEvalDataset(lib, { format: "promptfoo", ablation: true });

const feedback = await summarizeFeedback(lib);
await promoteFeedback(lib, { prune: true });

const diff = await diffLibrary(lib, { baseRef: "origin/main" });
console.log(formatDiffMarkdown(diff));
```

## Validating

```ts
import { Library, validateLibrary, formatDiagnostic, formatGitHubAnnotations, formatSarif, RULES } from "skanvil";

const lib = await Library.open(".");
const result = await validateLibrary(lib);
for (const d of result.diagnostics) {
  console.log(d.severity, formatDiagnostic(d), `[${d.rule}]`, RULES[d.rule].description);
}
const gh = formatGitHubAnnotations(result, lib);
const sarifJson = formatSarif(result, lib);
process.exitCode = result.errors > 0 ? 1 : 0;
```

`ValidationResult` is `{ diagnostics, count, errors, warnings }`. Each `Diagnostic` is `{ rule, severity, skill?, message, fixable?, file?, line? }`.

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
  includeDeprecated: false,
  dryRun: true
});
for (const r of results) {
  console.log(r.target, r.added, r.updated, r.removed, r.skipped, r.alwaysLoadedTokens);
}
```

## Building package exports

```ts
import { Library, buildLibrary, exportNames } from "skanvil";

const lib = await Library.open("./my-skills");
const { files, skills } = await buildLibrary(lib, { outDir: "dist" });
console.log(
  files,
  skills.map((s) => s.exportName)
);
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

| Export                                                                                                                     | Kind               | Purpose                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------- |
| `Library`                                                                                                                  | class              | Open a library; paths, skills and README I/O.             |
| `Categories`                                                                                                               | class              | Category lookup, prefix inference, name building.         |
| `SkillFile`                                                                                                                | class              | Parse and edit a `SKILL.md` without losing formatting.    |
| `createLibrary`, `parseProfile`                                                                                            | functions          | `skanvil init`.                                           |
| `scaffoldSkill`, `editSkill`, `removeSkill`, `importSkills`                                                                | functions          | `skanvil add` / `edit` / `import`.                        |
| `collectSkills`                                                                                                            | function           | `skanvil list` rows (with category/status/owner filters). |
| `validateLibrary`, `formatDiagnostic`, `formatGitHubAnnotations`, `formatSarif`, `resolveDiagnosticFile`, `RULES`          | functions / const  | `skanvil validate` and CI formatters.                     |
| `findBrokenReferences`, `findUnusedResources`                                                                              | functions          | Path and Stage-3 resource checks.                         |
| `analyzeLibraryStats`, `estimateTokens`                                                                                    | functions          | `skanvil stats` and Stage-1 token estimation.             |
| `parseEvals`, `readEvals`, `checkTriggerRouting`, `routePrompt`, `exportEvalDataset`, `EvalsFileSchema`, `EVALS_FILE`      | functions / consts | `skanvil eval triggers`, `route` and `export`.            |
| `readFeedbackLog`, `summarizeFeedback`, `promoteFeedback`, `FEEDBACK_FILE`                                                 | functions / const  | `.skanvil-feedback.jsonl` reader and promotion.           |
| `diffLibrary`, `formatDiffMarkdown`                                                                                        | functions          | `skanvil diff` Git snapshot comparison and PR Markdown.   |
| `rebuildIndex`, `reconcileIndex`, `doctor`                                                                                 | functions          | `skanvil index` / `doctor` (`DoctorOptions`).             |
| `resolveSkillTemplate`, `ejectSkillTemplate`                                                                               | functions          | Templates.                                                |
| `syncSkills`, `resolveTarget`, `resolveSource`, `resolveSourceHandle`, `parseGitSource`, `TARGET_PRESETS`, `MANIFEST_FILE` | functions / consts | Multi-library Manifest v2 sync and Git `--from`.          |
| `buildLibrary`, `exportNames`                                                                                              | functions          | `skanvil build` typed npm exports.                        |
| `installAgentSkill`, `agentSkillSource`, `feedbackSkillSource`, `AGENT_SKILL_NAME`, `FEEDBACK_SKILL_NAME`                  | functions / consts | `skanvil install-skill`.                                  |
| `estimateTokens`, `extractSection`, `stripFencedCode`, `tokenizeForSimilarity`, `jaccardSimilarity`                        | functions          | Text, section and lexical similarity helpers.             |
| `resolveConfig`, `loadConfig`, `ConfigSchema`, `configJsonSchema`, `DEFAULT_CATEGORIES`, `SKILL_STATUSES`, `CONFIG_FILE`   | functions / consts | Configuration and lifecycle constants.                    |
