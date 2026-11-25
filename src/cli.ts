#!/usr/bin/env node
/**
 * skanvil command-line entry point (`bin.skanvil` → `dist/cli.js`).
 *
 * Defines the commands with commander and delegates to the handlers in `src/commands/`.
 * Handler errors are printed as `skanvil: <message>` and set the exit code to 1. Running without
 * arguments opens the interactive wizard in a terminal; elsewhere (CI, pipes) it prints the help
 * and exits with 1.
 *
 * @module
 */
import { Command, Option } from "commander";

import { evalExportCommand, evalRouteCommand, evalTriggersCommand } from "./commands/evals.js";
import { feedbackListCommand, feedbackPromoteCommand } from "./commands/feedback.js";
import {
  buildCommand,
  diffCommand,
  doctorCommand,
  ejectCommand,
  indexCommand,
  initCommand,
  installSkillCommand,
  statsCommand,
  syncCommand,
  validateCommand
} from "./commands/library.js";
import { isInteractive } from "./commands/shared.js";
import { addCommand, editCommand, importCommand, listCommand } from "./commands/skills.js";
import { wizardCommand } from "./commands/wizard.js";
import { RULES } from "./core/validate.js";
import { TARGET_PRESETS } from "./core/sync.js";
import { packageVersion } from "./util/paths.js";

/** commander argument parser that accumulates a repeatable option into an array. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Wraps an async command so errors print cleanly and set the exit code. */
function run<A extends unknown[]>(handler: (...args: A) => Promise<number>) {
  return async (...args: A) => {
    try {
      process.exitCode = (await handler(...args)) || 0;
    } catch (error) {
      console.error(`skanvil: ${(error as Error)?.message ?? error}`);
      process.exitCode = 1;
    }
  };
}

const cwdOption = () => new Option("-C, --cwd <path>", "library root (default: current directory)");
const jsonOption = () => new Option("--json", "machine-readable JSON output");

/**
 * Builds the commander program with every command and option.
 *
 * @returns The configured program, ready for `parseAsync`.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("skanvil")
    .description("Generate, extend, validate and sync libraries of Agent Skills.")
    .version(packageVersion(), "--version", "show CLI version")
    .helpOption("-h, --help", "show help")
    .showHelpAfterError("(run 'skanvil --help' for usage)");

  program
    .command("wizard")
    .description("interactive assistant (also what 'skanvil' runs without arguments in a terminal)")
    .action(run(() => wizardCommand()));

  program
    .command("init [dir]")
    .description("create a new skills library")
    .option("--name <value>", "library name (default: folder name)")
    .option("--scope <value>", "npm scope, e.g. acme (generates @acme/<name>)")
    .option("--description <value>", "library description")
    .option("--profile <list>", "README sections of the default preset: front,back,transversal (default: all)")
    .option("--no-git", "skip git init")
    .option("--eject-templates", "copy the skill template into .skanvil/templates for customisation")
    .option("--no-agent-skill", "do not install the skanvil agent skill into the library")
    .option("--no-feedback", "do not install the skanvil-feedback skill alongside skanvil")
    .option(
      "--target <name>",
      "default sync targets written to .skanvilrc.json (also where the agent skill is installed); repeatable or comma-separated (default: claude)",
      collect
    )
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((dir, options) => initCommand(dir, options)));

  program
    .command("add")
    .description("add a skill to the library (interactive when --type, --name or --description are missing)")
    .option(
      "--type <category>",
      "category id or alias from .skanvilrc.json (default preset: front, back, transversal, internal)"
    )
    .option("--name <value>", "skill base name or final name")
    .option("--title <value>", "display title")
    .option("--description <value>", "what the skill does and when to use it")
    .option("--template <name>", "template folder under .skanvil/templates")
    .option("--no-assets", "do not create assets/")
    .option("--no-references", "do not create references/")
    .option("--no-scripts", "do not create scripts/")
    .option("--skip-validate", "do not validate after creating")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => addCommand(options)));

  program
    .command("edit <skill>")
    .description("rename, retype, retitle, redescribe or remove a skill")
    .option("--rename <value>", "new skill name")
    .option("--type <category>", "move the skill to another category")
    .option("--title <value>", "new title (heading and README entry)")
    .option("--description <value>", "new description")
    .option("--owner <value>", "set metadata.owner")
    .option("--status <value>", "set metadata.status (draft, experimental, active, deprecated)")
    .option("--replaced-by <skill>", "set metadata.replaced-by (implies --status deprecated)")
    .option("--remove", "delete the skill (asks for confirmation)")
    .option("--yes", "skip the confirmation prompt")
    .option("--skip-validate", "do not validate afterwards")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((skill, options) => editCommand(skill, options)));

  program
    .command("list")
    .description("list skills with category, README presence, validity and description")
    .option("--category <id>", "only skills of this category")
    .option("--status <value>", "only skills with this metadata.status")
    .option("--owner <value>", "only skills with this metadata.owner")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => listCommand(options)));

  program
    .command("validate")
    .description("check library conventions and the Agent Skills spec (exit 1 on errors)")
    .option("--strict", "treat warnings as errors")
    .option("--skill <name>", "only report problems of one skill")
    .option("--format <format>", "output format: text, github, sarif or json (default: text)")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .addHelpText(
      "after",
      `\nRules (severity configurable in .skanvilrc.json > validation.rules):\n${Object.entries(RULES)
        .map(([id, rule]) => `  ${id.padEnd(22)} ${rule.severity.padEnd(5)} ${rule.description}`)
        .join("\n")}`
    )
    .action(run((options) => validateCommand(options)));

  program
    .command("index")
    .description("regenerate the README skills index from the skill folders")
    .option("--check", "do not write; exit 1 if the index is out of date (for CI)")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => indexCommand(options)));

  program
    .command("doctor")
    .description("diagnose the library and optionally repair fixable problems")
    .option("--fix", "apply automatic fixes (README entries, name mismatch, tabs, tools -> allowed-tools)")
    .option("--scaffold-sections", "insert minimal stubs for missing required sections (requires --fix)")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => doctorCommand(options)));

  program
    .command("stats")
    .description("show 3-stage token and size budgets for validated skills")
    .option("--category <id>", "only include skills of this category")
    .option("--skill <name>", "only inspect one skill")
    .option("--sort <key>", "sort by: tokens, lines or name (default: name)")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => statsCommand(options)));

  const evalCmd = program.command("eval").description("check trigger routing and export evaluation suites");
  evalCmd
    .command("triggers")
    .description("test declared triggers in evals.json against skill descriptions offline")
    .option("--skill <name>", "only check triggers of one skill")
    .option("--split <name>", "only check prompts tagged 'train' or 'eval'")
    .option("--strict", "exit 1 when any trigger check fails")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => evalTriggersCommand(options)));
  evalCmd
    .command("export")
    .description("export evals.json cases and triggers for external runners (JSON or Promptfoo)")
    .option("--format <format>", "output format: json or promptfoo (default: json)")
    .option("--ablation", "pair each case with a without-skill baseline variant")
    .option("--skill <name>", "only export one skill")
    .option("--split <name>", "only export items tagged 'train' or 'eval'")
    .option("--out <file>", "write the dataset to a file instead of stdout")
    .addOption(cwdOption())
    .action(run((options) => evalExportCommand(options)));
  evalCmd
    .command("route <prompt>")
    .description("simulate Stage-1 offline BM25 trigger routing for a user prompt")
    .option("--top <n>", "maximum matching skills to return (default: 5)")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((prompt, options) => evalRouteCommand(prompt, options)));

  const feedbackCmd = program
    .command("feedback")
    .description("inspect and promote friction logs from .skanvil-feedback.jsonl");
  feedbackCmd
    .command("list")
    .description("summarize grouped friction entries logged by coding agents")
    .option("--file <path>", "path to feedback JSONL file (default: .skanvil-feedback.jsonl)")
    .option("--skill <name>", "only include entries for one skill")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => feedbackListCommand(options)));
  feedbackCmd
    .command("promote")
    .description("promote validated suggestedEvalCase entries into skill evals.json files")
    .option("--file <path>", "path to feedback JSONL file (default: .skanvil-feedback.jsonl)")
    .option("--skill <name>", "only promote entries for one skill")
    .option("--dry-run", "preview promotions without modifying evals.json or the log")
    .option("--prune", "remove promoted entries from the feedback JSONL log")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => feedbackPromoteCommand(options)));

  const templates = program.command("templates").description("manage skill templates");
  templates
    .command("eject")
    .description("copy the built-in skill template into the library for customisation")
    .option("--category <id>", "eject as a category-specific template (skill-<id>)")
    .option("--force", "overwrite an existing template folder")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => ejectCommand(options)));

  program
    .command("build")
    .description("generate the library's npm exports: one typed function per skill (dist/index.mjs, index.cjs, .d.ts)")
    .option("--out <dir>", "output folder relative to the library root (default: dist)")
    .option("--force", "build even when validation reports errors")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => buildCommand(options)));

  program
    .command("install-skill [dest]")
    .description("install or update the skanvil agent skill so coding agents in a project know how to use skanvil")
    .option(
      "--target <name>",
      `preset (${Object.keys(TARGET_PRESETS).join(", ")}) or path relative to dest; repeatable or comma-separated (default: claude)`,
      collect
    )
    .option("--force", "replace a 'skanvil' skill folder that skanvil did not install, or reinstall the same version")
    .option(
      "--global",
      "install into your user agent folders (~/.claude/skills, ~/.cursor/skills, ~/.gemini/skills, ...)"
    )
    .option("--no-feedback", "do not install the skanvil-feedback skill alongside skanvil")
    .addOption(jsonOption())
    .action(run((dest, options) => installSkillCommand(dest, options)));

  program
    .command("sync [dest]")
    .description("install the library's skills into agent folders of a project (default dest: current directory)")
    .option(
      "--target <name>",
      `preset (${Object.keys(TARGET_PRESETS).join(", ")}) or path relative to dest; repeatable or comma-separated`,
      collect
    )
    .option(
      "--from <pkg|path|git>",
      "skills library to install (folder, installed npm package, or Git URL/github:owner/repo); default: --cwd"
    )
    .option("--link", "symlink skills instead of copying (junctions on Windows)")
    .option("--copy", "copy skills (overrides sync.mode = link)")
    .option("--category <id>", "only skills of this category (repeatable)", collect)
    .option("--skill <name>", "only this skill (repeatable)", collect)
    .option("--status <value>", "only skills with this metadata.status (repeatable)", collect)
    .option("--include-deprecated", "also sync skills with metadata.status: deprecated")
    .option("--force", "also sync skills with validation errors")
    .option("--dry-run", "show what would change without writing")
    .option("--param <name=value>", "value for parametrized skills (repeatable); remembered per target", collect)
    .option(
      "--global",
      "install into your user agent folders (~/.claude/skills, ~/.cursor/skills, ~/.gemini/skills, ...)"
    )
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((dest, options) => syncCommand(dest, options)));

  program
    .command("import <sourceDir>")
    .description("import existing skill folders into the library and normalise frontmatter")
    .option("--type <category>", "target category id or alias (applies folder prefix and metadata)")
    .option("--skill <name>", "only import specific skill(s) (repeatable or comma-separated)", collect)
    .option("--dry-run", "preview what would be imported without writing")
    .option("--overwrite", "replace existing skill folders with the same resolved name")
    .option("--skip-validate", "do not validate after importing")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((sourceDir, options) => importCommand(sourceDir, options)));

  program
    .command("diff [baseRef]")
    .description("compare the library against a Git ref (Stage-1 token delta, validation and trigger regressions)")
    .option("--format <format>", "output format: text or markdown (default: text)")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((baseRef, options) => diffCommand(baseRef, options)));

  return program;
}

const argv = process.argv.slice(2);
const program = buildProgram();
if (argv.length === 0 && isInteractive()) {
  await program.parseAsync([...process.argv, "wizard"]);
} else if (argv.length === 0) {
  program.outputHelp();
  process.exitCode = 1;
} else {
  await program.parseAsync(process.argv);
}
