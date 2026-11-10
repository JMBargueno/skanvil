// Writes schema.json (JSON Schema for .skanvilrc.json) from the built package.
import { writeFileSync } from "node:fs";
import { configJsonSchema } from "../dist/index.js";

const schema = { title: "skanvil configuration (.skanvilrc.json)", ...configJsonSchema() };
writeFileSync(new URL("../schema.json", import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
console.log("schema.json written");
