/**
 * vitest global setup: bundles the CLI into `tmp/cli-build` for the integration tests in
 * `tests/cli.test.ts`. A separate output folder keeps the real `dist/` (and its type
 * declarations) untouched.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

export const CLI_BUILD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tmp", "cli-build");

export default async function setup(): Promise<void> {
  await build({
    config: false,
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    outDir: CLI_BUILD_DIR,
    clean: true,
    dts: false,
    silent: true
  });
}
