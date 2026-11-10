import { describe, expect, test } from "vitest";

import { Categories } from "../src/core/categories.js";
import { resolveConfig } from "../src/core/config.js";
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
import { placeholderPattern } from "../src/core/validate.js";

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
