import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { Categories } from "../src/core/categories.js";
import { resolveConfig } from "../src/core/config.js";
import { parseEvals } from "../src/core/evals.js";
import { toKebabCase } from "../src/core/naming.js";
import {
  buildEntry,
  getEntry,
  insertEntry,
  parseIndex,
  removeEntry,
  replaceEntry,
  setSection
} from "../src/core/readme-index.js";
import { SkillFile } from "../src/core/skill.js";
import { parseGitSource, resolveTarget } from "../src/core/sync.js";
import {
  estimateTokens,
  extractSection,
  jaccardSimilarity,
  stripFencedCode,
  tokenizeForSimilarity
} from "../src/core/text.js";
import { findUnusedResources, placeholderPattern } from "../src/core/validate.js";

const README = [
  "# Lib",
  "",
  "<details>",
  "<summary><strong>Front</strong></summary>",
  "",
  "</details>",
  "",
  "<details>",
  "<summary><strong>Backend</strong></summary>",
  "",
  "</details>",
  ""
].join("\n");

const categories = new Categories(resolveConfig().categories);

describe("naming with the default preset", () => {
  test("builds prefixed kebab-case names", () => {
    expect(toKebabCase("  Árbol Grande!! ")).toBe("arbol-grande");
    expect(categories.buildName("front", "front-api review")).toBe("front-api-review");
    expect(categories.buildName("back", "api")).toBe("back-api");
    expect(categories.buildName("backend", "api")).toBe("back-api");
    expect(categories.buildName("internal", "tools")).toBe("_tools");
    expect(categories.buildName("transversal", "_back-x")).toBe("x");
    expect(categories.buildTitle("front", "api-review", "")).toBe("Api Review");
    expect(categories.fromFolder("_x").id).toBe("internal");
    expect(categories.fromFolder("front-x").id).toBe("front");
    expect(categories.fromFolder("x").id).toBe("transversal");
    expect(() => categories.resolve("nope")).toThrow(/Invalid skill type/);
  });
});

describe("config", () => {
  test("a minimal rc with only name/scope resolves to the default preset", () => {
    const config = resolveConfig({ name: "lib", scope: "acme" });
    expect(config.categories.map((category) => category.id)).toEqual(["front", "back", "transversal", "internal"]);
    expect(config.skillsDir).toBe("skills");
  });

  test("custom categories with longest-prefix inference", () => {
    const custom = new Categories(
      resolveConfig({
        categories: [
          { id: "mobile", prefix: "mobile-" },
          { id: "data", prefix: "data-", title: "Data & ML", aliases: ["ml"] },
          { id: "general", default: true }
        ]
      }).categories
    );
    expect(custom.buildName("ml", "Feature Store")).toBe("data-feature-store");
    expect(custom.fromFolder("mobile-x").id).toBe("mobile");
    expect(custom.fromFolder("x").id).toBe("general");
    expect(custom.byId("mobile")!.title).toBe("Mobile");
  });

  test("rejects ambiguous or invalid category setups", () => {
    expect(() => resolveConfig({ categories: [{ id: "a", prefix: "a-" }] })).toThrow(
      /exactly one category must be the default/
    );
    expect(() =>
      resolveConfig({
        categories: [
          { id: "a", prefix: "x-" },
          { id: "b", prefix: "x-y-" },
          { id: "c", default: true }
        ]
      })
    ).toThrow(/ambiguous/);
    expect(() => resolveConfig({ categories: [{ id: "a", prefix: "Bad" }] })).toThrow(/prefix must be/);
    expect(() => resolveConfig({ unknown: true })).toThrow(/Invalid \.skanvilrc\.json/);
  });
});

describe("SkillFile", () => {
  test("updates fields without touching the body", () => {
    const skill = SkillFile.parse("---\nname: a\ndescription: old\n---\n\n# Title\n\nname: keep\n");
    skill.set(["name"], "b");
    skill.setTitle("New");
    const updated = skill.toString();

    expect(SkillFile.parse(updated).getString("name")).toBe("b");
    expect(SkillFile.parse(updated).getString("description")).toBe("old");
    expect(updated).toMatch(/^# New$/m);
    expect(updated).toMatch(/name: keep/);
  });

  test("reads multi-line descriptions and keeps comments and CRLF", () => {
    const source = "---\r\nname: a\r\n# a comment\r\ndescription: >\r\n  Folded\r\n  text.\r\n---\r\n\r\n# T\r\n";
    const skill = SkillFile.parse(source);
    expect(skill.getString("description")).toBe("Folded text.");
    expect(skill.toString()).toBe(source);

    skill.set(["name"], "b");
    const out = skill.toString();
    expect(out).toContain("# a comment");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test("detects missing and invalid frontmatter", () => {
    expect(SkillFile.parse("# no fm").hasFrontmatter).toBe(false);
    expect(SkillFile.parse("---\nname: [unclosed\n---\n").isValidYaml).toBe(false);
    expect(SkillFile.parse("---\ndescription: a---b\n---\n").getString("description")).toBe("a---b");
  });
});

describe("readme index", () => {
  test("inserts, replaces and removes entries", () => {
    const entry = buildEntry({ title: "Demo", description: "Does things", skillName: "front-demo" });
    let readme = insertEntry(README, "Front", entry);

    expect(readme).toMatch(/<\/summary>\n\n- Demo/);
    expect([...parseIndex(readme, ["Front"]).get("Front")!]).toEqual(["front-demo"]);
    expect(getEntry(readme, "front-demo")!.description).toBe("Does things.");

    readme = replaceEntry(
      readme,
      "front-demo",
      buildEntry({ title: "Demo2", description: "x", skillName: "front-demo2" })
    );
    expect(getEntry(readme, "front-demo")).toBeNull();
    expect(getEntry(readme, "front-demo2")!.title).toBe("Demo2");

    readme = removeEntry(readme, "front-demo2");
    expect(parseIndex(readme, ["Front"]).get("Front")!.size).toBe(0);
    expect(readme).not.toMatch(/\n\n\n/);
  });

  test("creates a missing section", () => {
    const entry = buildEntry({ title: "Shared", description: "x", skillName: "shared" });
    expect(insertEntry(README, "Transversal", entry)).toMatch(/<strong>Transversal<\/strong>/);
  });

  test("setSection output matches what insertEntry produces", () => {
    const a = buildEntry({ title: "A", description: "a", skillName: "front-a" });
    const b = buildEntry({ title: "B", description: "b", skillName: "front-b" });
    expect(setSection(README, "Front", [a, b])).toBe(insertEntry(insertEntry(README, "Front", a), "Front", b));
    expect(setSection(setSection(README, "Front", [a]), "Front", [])).toBe(README);
  });
});

test("placeholder patterns", () => {
  expect(placeholderPattern("TODO").test("x\nTODO later")).toBe(true);
  expect(placeholderPattern("TODO").test("todos")).toBe(false);
  expect(placeholderPattern("tbd").test("It is TBD.")).toBe(true);
  expect(placeholderPattern("describe...").test("Describe... here")).toBe(true);
});

describe("text, token and similarity helpers", () => {
  test("estimateTokens approximates ~4 chars per token and ignores blank text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n  ")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("stripFencedCode removes backtick and tilde fences cleanly", () => {
    const md = [
      "Before.",
      "```ts",
      "## Fake Heading",
      "try again",
      "```",
      "Middle.",
      "~~~",
      "inside tilde",
      "~~~",
      "After."
    ].join("\n");
    expect(stripFencedCode(md)).toBe("Before.\nMiddle.\nAfter.");
  });

  test("extractSection locates headings case-insensitively and ignores fenced headings", () => {
    const body = [
      "# Title",
      "",
      "## Instructions",
      "",
      "```md",
      "## Error Recovery",
      "Not a real section",
      "```",
      "",
      "1. Run check.",
      "",
      "## Error Recovery",
      "",
      "| Failure | Action |",
      "| --- | --- |",
      "| Lint fails | Fix it |"
    ].join("\n");

    const instructions = extractSection(body, ["instructions"]);
    expect(instructions).toContain("1. Run check.");
    expect(instructions).toContain("Not a real section");

    const recovery = extractSection(body, ["error recovery", "troubleshooting"]);
    expect(recovery).toContain("| Lint fails | Fix it |");
    expect(extractSection(body, ["missing"])).toBeNull();
  });

  test("tokenizeForSimilarity drops stopwords/short tokens and computes Jaccard similarity", () => {
    const a = tokenizeForSimilarity("Reviews API changes for typing and error handling.");
    const b = tokenizeForSimilarity("Reviews API changes for error handling and retries.");
    expect(a).toEqual(["reviews", "api", "changes", "typing", "error", "handling"]);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(5 / 7, 5);
    expect(jaccardSimilarity([], [])).toBe(0);
  });
});

describe("findUnusedResources", () => {
  test("flags unreferenced resource files while allowing folder references and dotfiles", () => {
    const files = new Set([
      "SKILL.md",
      "references/REFERENCE.md",
      "references/extra.md",
      "scripts/helper.js",
      "assets/.gitkeep"
    ]);
    const body = [
      "Read [the reference](references/REFERENCE.md) for rules.",
      "Use helpers inside `scripts/` when needed."
    ].join("\n");

    expect(findUnusedResources(body, files)).toEqual(["references/extra.md"]);
  });
});

describe("parseEvals", () => {
  test("normalizes triggers and validates cases", () => {
    const parsed = parseEvals(
      JSON.stringify({
        triggers: {
          shouldTrigger: ["Audit checkout modal", { prompt: "Check ARIA roles", split: "eval", note: "a11y" }],
          shouldNotTrigger: ["Run database migration"]
        },
        cases: [
          {
            id: "modal-a11y",
            split: "eval",
            prompt: "Audit Modal.tsx",
            params: { strict: true },
            expected: ["Identifies missing focus trap"]
          }
        ]
      })
    );
    expect(parsed.triggers?.shouldTrigger).toEqual([
      { prompt: "Audit checkout modal" },
      { prompt: "Check ARIA roles", split: "eval", note: "a11y" }
    ]);
    expect(parsed.cases?.[0].id).toBe("modal-a11y");
  });

  test("rejects invalid JSON, non-kebab case ids, duplicate ids and unknown fields", () => {
    expect(() => parseEvals("{")).toThrow(/not valid JSON/);
    expect(() => parseEvals(JSON.stringify({ cases: [{ id: "BadId", prompt: "x", expected: ["y"] }] }))).toThrow(
      /kebab-case/
    );
    expect(() =>
      parseEvals(
        JSON.stringify({
          cases: [
            { id: "dup", prompt: "x", expected: ["y"] },
            { id: "dup", prompt: "z", expected: ["w"] }
          ]
        })
      )
    ).toThrow(/duplicated case id 'dup'/);
    expect(() => parseEvals(JSON.stringify({ extra: true }))).toThrow(/invalid evals.json/);
  });
});

describe("sync presets and git source parser", () => {
  test("resolves expanded agent presets for project and user scopes", () => {
    const root = path.resolve(os.tmpdir(), "demo-proj");
    const home = path.resolve(os.tmpdir(), "demo-home");

    expect(resolveTarget(root, "cursor")).toBe(path.join(root, ".cursor", "skills"));
    expect(resolveTarget(root, "opencode")).toBe(path.join(root, ".opencode", "skills"));
    expect(resolveTarget(root, "windsurf")).toBe(path.join(root, ".windsurf", "skills"));
    expect(resolveTarget(root, "gemini")).toBe(path.join(root, ".gemini", "skills"));

    expect(resolveTarget(root, "cursor", { scope: "user", homeDir: home })).toBe(path.join(home, ".cursor", "skills"));
    expect(resolveTarget(root, "opencode", { scope: "user", homeDir: home })).toBe(
      path.join(home, ".config", "opencode", "skills")
    );
    expect(resolveTarget(root, "windsurf", { scope: "user", homeDir: home })).toBe(
      path.join(home, ".codeium", "windsurf", "skills")
    );
    expect(resolveTarget(root, "gemini", { scope: "user", homeDir: home })).toBe(path.join(home, ".gemini", "skills"));
  });

  test("parseGitSource supports shorthands, refs, and SSH/HTTPS URLs while ignoring paths and npm packages", () => {
    expect(parseGitSource("github:acme/skills")).toEqual({
      url: "https://github.com/acme/skills.git",
      canonical: "github:acme/skills"
    });
    expect(parseGitSource("github:acme/skills#v1.2.0")).toEqual({
      url: "https://github.com/acme/skills.git",
      ref: "v1.2.0",
      canonical: "github:acme/skills#v1.2.0"
    });
    expect(parseGitSource("git+https://example.com/team/skills.git#main")).toEqual({
      url: "https://example.com/team/skills.git",
      ref: "main",
      canonical: "git+https://example.com/team/skills.git#main"
    });
    expect(parseGitSource("https://example.com/team/skills.git")).toEqual({
      url: "https://example.com/team/skills.git",
      canonical: "https://example.com/team/skills.git"
    });
    expect(parseGitSource("git@github.com:acme/skills.git#release")).toEqual({
      url: "git@github.com:acme/skills.git",
      ref: "release",
      canonical: "git@github.com:acme/skills.git#release"
    });
    expect(parseGitSource("git+file:///tmp/my-skills#dev")).toEqual({
      url: "file:///tmp/my-skills",
      ref: "dev",
      canonical: "git+file:///tmp/my-skills#dev"
    });

    expect(parseGitSource("../local-lib")).toBeNull();
    expect(parseGitSource("@acme/skills")).toBeNull();
    expect(parseGitSource("--upload-pack=evil")).toBeNull();
    expect(() => parseGitSource("github:acme/skills#--evil")).toThrow(/Invalid Git ref/);
  });
});
