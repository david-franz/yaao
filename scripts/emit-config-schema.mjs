// Emits schema/config.schema.json from the built Zod schema. Runs after `tsup`, which
// produces dist/index.js with ConfigSchema exported.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { ConfigSchema } = await import(join(root, 'dist', 'index.js'));

const outDir = join(root, 'schema');
mkdirSync(outDir, { recursive: true });

const json = zodToJsonSchema(ConfigSchema, { name: 'YaaoConfig' });
writeFileSync(join(outDir, 'config.schema.json'), `${JSON.stringify(json, null, 2)}\n`);
process.stdout.write('wrote schema/config.schema.json\n');
