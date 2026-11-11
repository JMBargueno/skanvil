import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

import { buildLibrary, exportNames } from "../src/core/build.js";
import { createLibrary } from "../src/core/init.js";
import { Library } from "../src/core/library.js";
import {
  findUndeclaredParams,
  parseParamPairs,
  parseParams,
  renderTemplate,
  resolveParamValues
} from "../src/core/params.js";
import { scaffoldSkill } from "../src/core/skills.js";
import { syncSkills } from "../src/core/sync.js";
import { validateLibrary } from "../src/core/validate.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skanvil-params-"));
}

const PARAMS = {
  ticketTracker: {
    type: "enum",
    values: ["github", "jira", "linear"],
    default: "github",
    description: "Issue tracker"
  },
  packageManager: { type: "string", default: "npm" },
  strict: { type: "boolean", default: false }
};

/** A library with a parametrized `front-code-review` skill and a plain `back-svc` skill. */
async function library(): Promise<string> {
  const root = path.join(tmp(), "lib");
  await createLibrary(root, { git: false, agentSkill: false, name: "acme-skills", scope: "acme" });
  await scaffoldSkill(root, { type: "front", name: "code review", description: "Reviews code" });
  await scaffoldSkill(root, { type: "back", name: "svc", description: "Service work" });
  const dir = path.join(root, "skills", "front-code-review");
  fs.writeFileSync(path.join(dir, "params.json"), JSON.stringify(PARAMS, null, 2));
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(
        "## Output Format",
        [
          "Run `{{packageManager}} test` and link findings to {{ticketTracker}}.",
          '{{#if ticketTracker == "jira"}}',
          "Use the PROJ-123 key format.",
          "{{else}}",
          "Reference issues as #123.",
          "{{/if}}",
          "{{#if strict}}",
          "Block the merge on any finding.",
          "{{/if}}",
          "",
          "## Output Format"
        ].join("\n")
      )
  );
  return root;
}

describe("template language", () => {
  test("replaces declared parameters and leaves other braces alone", () => {
    expect(renderTemplate("Use {{tool}} and {{other}}.", { tool: "jest" })).toBe("Use jest and {{other}}.");
  });

  test("conditions, else, nesting and standalone tag lines", () => {
    const template = [
      "start",
      '{{#if tracker == "jira"}}',
      "jira",
      "  {{#if strict}}",
      "  strict jira",
      "  {{/if}}",
      "{{else}}",
      "not jira",
      "{{/if}}",
      "{{#if !strict}}lenient{{/if}} end",
      ""
    ].join("\n");
    expect(renderTemplate(template, { tracker: "jira", strict: true })).toBe("start\njira\n  strict jira\n end\n");
    expect(renderTemplate(template, { tracker: "github", strict: false })).toBe("start\nnot jira\nlenient end\n");
    expect(renderTemplate("{{#if t != 'a'}}x{{/if}}", { t: "b" })).toBe("x");
  });

  test("keeps CRLF line endings", () => {
    expect(renderTemplate("a\r\n{{#if on}}\r\nb\r\n{{/if}}\r\nc\r\n", { on: true })).toBe("a\r\nb\r\nc\r\n");
  });

  test("reports malformed templates", () => {
    expect(() => renderTemplate("{{#if nope}}x{{/if}}", {})).toThrow(/unknown parameter 'nope'/);
    expect(() => renderTemplate("{{#if a}}x", { a: true })).toThrow(/not closed/);
    expect(() => renderTemplate("x{{/if}}", {})).toThrow(/without a matching/);
    expect(() => renderTemplate("{{#if a > 1}}x{{/if}}", { a: "2" })).toThrow(/invalid condition/);
    expect(findUndeclaredParams("{{a}} {{ b }} {{else}} {{#if a}}", { a: PARAMS.strict as never })).toEqual(["b"]);
  });
});

describe("parameter values", () => {
  test("defaults, CLI strings and errors", () => {
    const definitions = parseParams(JSON.stringify(PARAMS));
    expect(resolveParamValues(definitions)).toEqual({ ticketTracker: "github", packageManager: "npm", strict: false });
    expect(resolveParamValues(definitions, { strict: "true", ticketTracker: "jira" })).toMatchObject({
      strict: true,
      ticketTracker: "jira"
    });
    expect(() => resolveParamValues(definitions, { ticketTracker: "trello" }, "review")).toThrow(
      /review: parameter 'ticketTracker' must be one of github, jira, linear/
    );
    expect(() => resolveParamValues(definitions, { nope: "x" }, "review")).toThrow(/review has no parameter 'nope'/);
    expect(resolveParamValues(definitions, { nope: "x" }, "review", true)).not.toHaveProperty("nope");
    expect(() => resolveParamValues(definitions, { strict: "yes" })).toThrow(/true or false/);
  });

  test("params.json and --param parsing", () => {
    expect(() => parseParams('{"x": {"type": "enum", "values": ["a"], "default": "b"}}')).toThrow(/must be one of a/);
    expect(() => parseParams('{"x": {"type": "string"}}')).toThrow(/invalid params.json/);
    expect(() => parseParams('{"bad-name": {"type": "string", "default": ""}}')).toThrow(/camelCase/);
    expect(() => parseParams("{")).toThrow(/not valid JSON/);
    expect(parseParamPairs(["a=1", "url=https://x.test/?q=1"])).toEqual({ a: "1", url: "https://x.test/?q=1" });
    expect(() => parseParamPairs(["oops"])).toThrow(/Use name=value/);
  });
});

describe("parametrized skills in a library", () => {
  test("validate checks the rendered skill and the template", async () => {
    const root = await library();
    const lib = await Library.open(root);
    expect((await validateLibrary(lib)).errors).toBe(0);
    expect((await lib.describeSkill("front-code-review")).description).toBe("Reviews code.");

    const file = path.join(root, "skills", "front-code-review", "SKILL.md");
    fs.appendFileSync(file, "\nAsk {{reviewer}}.\n{{#if ticketTracker}}\n");
    const rules = (await validateLibrary(lib)).diagnostics.map((d) => `${d.rule}:${d.message}`);
    expect(rules.some((rule) => /params-template:.*\{\{reviewer\}\}/.test(rule))).toBe(true);
    expect(rules.some((rule) => /params-template:.*not closed/.test(rule))).toBe(true);

    fs.writeFileSync(path.join(root, "skills", "front-code-review", "params.json"), '{"x": {"type": "string"}}');
    expect((await validateLibrary(lib)).diagnostics.map((d) => d.rule)).toContain("params-file");
  });

  test("sync renders skills with --param values and remembers them per target", async () => {
    const root = await library();
    const project = tmp();
    const lib = await Library.open(root);
    const skillFile = path.join(project, ".claude", "skills", "front-code-review", "SKILL.md");

    let [result] = await syncSkills(lib, { dest: project, targets: ["claude"], params: { ticketTracker: "jira" } });
    expect(result.added.sort()).toEqual(["back-svc", "front-code-review"]);
    expect(result.params).toEqual({ ticketTracker: "jira" });
    const installed = fs.readFileSync(skillFile, "utf8");
    expect(installed).toMatch(/Run `npm test` and link findings to jira\./);
    expect(installed).toMatch(/PROJ-123/);
    expect(installed).not.toMatch(/\{\{|#123|Block the merge/);
    expect(fs.existsSync(path.join(project, ".claude", "skills", "front-code-review", "params.json"))).toBe(false);

    [result] = await syncSkills(lib, { dest: project, targets: ["claude"] });
    expect(result.unchanged.sort()).toEqual(["back-svc", "front-code-review"]);

    [result] = await syncSkills(lib, { dest: project, targets: ["claude"], params: { strict: true } });
    expect(result.updated).toEqual(["front-code-review"]);
    expect(fs.readFileSync(skillFile, "utf8")).toMatch(/#123[\s\S]*Block the merge/);

    await expect(syncSkills(lib, { dest: project, targets: ["claude"], params: { nope: "x" } })).rejects.toThrow(
      /Unknown parameter\(s\) nope/
    );
    await expect(
      syncSkills(lib, { dest: project, targets: ["claude"], params: { ticketTracker: "trello" } })
    ).rejects.toThrow(/must be one of/);
  });

  test("link mode copies parametrized skills rendered", async () => {
    const root = await library();
    const project = tmp();
    const [result] = await syncSkills(await Library.open(root), { dest: project, targets: ["agents"], mode: "link" });
    expect(result.warnings).toEqual(["front-code-review has parameters, so it was copied rendered instead of linked"]);
    expect(fs.lstatSync(path.join(project, ".agents", "skills", "front-code-review")).isSymbolicLink()).toBe(false);
  });
});

describe("build", () => {
  test("generates working ESM and CJS exports", async () => {
    const root = await library();
    const lib = await Library.open(root);
    const result = await buildLibrary(lib);
    expect(result.files).toEqual(["dist/index.mjs", "dist/index.cjs", "dist/index.d.mts", "dist/index.d.cts"]);
    expect(result.skills).toEqual([
      { name: "back-svc", exportName: "svc", category: "back", params: [] },
      {
        name: "front-code-review",
        exportName: "codeReview",
        category: "front",
        params: ["ticketTracker", "packageManager", "strict"]
      }
    ]);

    const esm = await import(pathToFileURL(path.join(root, "dist", "index.mjs")).href);
    expect(esm.codeReview({ ticketTracker: "linear", packageManager: "pnpm" })).toMatch(
      /Run `pnpm test` and link findings to linear\.\nReference issues as #123\./
    );
    expect(esm.codeReview()).toBe(esm.getSkill("front-code-review").render());
    expect(() => esm.codeReview({ ticketTracker: "trello" })).toThrow(/must be one of/);
    expect(esm.svc()).toMatch(/^---\nname: back-svc/);

    const files = esm.getSkill("front-code-review").files({ strict: true });
    expect(Object.keys(files).sort()).toEqual([
      "SKILL.md",
      "assets/output-template.md",
      "references/REFERENCE.md",
      "scripts/example-helper.js"
    ]);
    expect(files["SKILL.md"].content).toMatch(/Block the merge/);

    const cjs = createRequire(import.meta.url)(path.join(root, "dist", "index.cjs"));
    expect(cjs.codeReview({ ticketTracker: "jira" })).toBe(esm.codeReview({ ticketTracker: "jira" }));
    expect(cjs.skills.map((skill: { name: string }) => skill.name)).toEqual(["back-svc", "front-code-review"]);
  });

  test("type declarations reject wrong parameters", async () => {
    const root = await library();
    await buildLibrary(await Library.open(root));
    const consumer = path.join(root, "consumer.mts");
    fs.writeFileSync(
      consumer,
      [
        'import { codeReview, getSkill, skills, type CodeReviewParams } from "./dist/index.mjs";',
        'const ok: string = codeReview({ ticketTracker: "jira", strict: true });',
        "const params: CodeReviewParams = {};",
        '// @ts-expect-error "trello" is not a valid tracker',
        'codeReview({ ticketTracker: "trello" });',
        "// @ts-expect-error unknown parameter",
        "codeReview({ reviewer: 'x' });",
        "// @ts-expect-error unknown skill name",
        'getSkill("nope");',
        "export const all = [ok, params, skills.length];"
      ].join("\n")
    );
    const program = ts.createProgram([consumer], {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: false,
      types: []
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  test("refuses to build with validation errors unless forced", async () => {
    const root = await library();
    fs.appendFileSync(path.join(root, "skills", "back-svc", "SKILL.md"), "\nTODO\n");
    const lib = await Library.open(root);
    await expect(buildLibrary(lib)).rejects.toThrow(/Validation found 1 error/);
    await expect(buildLibrary(lib, { force: true })).resolves.toMatchObject({ skills: expect.any(Array) });
  });

  test("export names avoid collisions and reserved words", async () => {
    const lib = new Library(tmp());
    expect(
      Object.fromEntries(exportNames(lib, ["front-review", "back-review", "default", "transversal", "2fa-setup"]))
    ).toEqual({
      "front-review": "frontReview",
      "back-review": "backReview",
      default: "skillDefault",
      transversal: "transversal",
      "2fa-setup": "skill2faSetup"
    });
  });
});
