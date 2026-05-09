// Emits schema/*.schema.json from the built Zod schemas. Runs after `tsup`, which
// produces dist/index.js with ConfigSchema and PlanSchema exported.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { ConfigSchema, PlanSchema } = await import(join(root, 'dist', 'index.js'));

const outDir = join(root, 'schema');
mkdirSync(outDir, { recursive: true });

const writeSchema = (defName, file, schema) => {
  const json = zodToJsonSchema(schema, { name: defName });
  writeFileSync(join(outDir, file), `${JSON.stringify(json, null, 2)}\n`);
  process.stdout.write(`wrote schema/${file}\n`);
};

writeSchema('YaaoConfig', 'config.schema.json', ConfigSchema);
writeSchema('ExecutionPlan', 'execution-plan.schema.json', PlanSchema);
