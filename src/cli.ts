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

import {
  doctorCommand,
  ejectCommand,
  indexCommand,
  buildCommand,
  initCommand,
  installSkillCommand,
  syncCommand,
  validateCommand
} from "./commands/library.js";
import { isInteractive } from "./commands/shared.js";
import { addCommand, editCommand, listCommand } from "./commands/skills.js";
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
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => listCommand(options)));

  program
    .command("validate")
    .description("check library conventions and the Agent Skills spec (exit 1 on errors)")
    .option("--strict", "treat warnings as errors")
    .option("--skill <name>", "only report problems of one skill")
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
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((options) => doctorCommand(options)));

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
    .option("--global", "install into your user folders (~/.claude/skills, ~/.copilot/skills, ~/.agents/skills)")
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
    .option("--from <pkg|path>", "skills library to install (npm package in node_modules or folder); default: --cwd")
    .option("--link", "symlink skills instead of copying (junctions on Windows)")
    .option("--copy", "copy skills (overrides sync.mode = link)")
    .option("--category <id>", "only skills of this category (repeatable)", collect)
    .option("--skill <name>", "only this skill (repeatable)", collect)
    .option("--force", "also sync skills with validation errors")
    .option("--dry-run", "show what would change without writing")
    .option("--param <name=value>", "value for parametrized skills (repeatable); remembered per target", collect)
    .option("--global", "install into your user folders (~/.claude/skills, ~/.copilot/skills, ~/.agents/skills)")
    .addOption(cwdOption())
    .addOption(jsonOption())
    .action(run((dest, options) => syncCommand(dest, options)));

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
