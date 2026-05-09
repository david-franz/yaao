import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { createRequire } from 'node:module';

// ajv is CommonJS; the cleanest way to get the constructor under NodeNext + ESM is
// the createRequire bridge. The runtime export is the constructor; the d.ts puts it
// on `.default`, so we cast to a constructor type.
type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown };
type AjvCtor = new (opts?: { allErrors?: boolean; strict?: boolean }) => {
  compile: (schema: unknown) => ValidateFn;
};
const requireFromHere = createRequire(import.meta.url);
const Ajv = requireFromHere('ajv') as AjvCtor;
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PlanSchema } from '../../../src/plan/schema/plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

function loadExample(name: string): unknown {
  return parse(readFileSync(join(root, 'examples', name), 'utf8'));
}

describe('JSON Schema export round-trip', () => {
  const json = zodToJsonSchema(PlanSchema, { name: 'ExecutionPlan' });
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(json);

  it('the same examples that pass Zod also pass ajv', () => {
    for (const file of ['oauth.yaml', 'minimal.yaml']) {
      const data = loadExample(file);
      expect(validate(data), `ajv errors for ${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('a deliberately broken plan fails ajv', () => {
    const bad = { plan: { name: 'BAD NAME', version: 1 }, tasks: [] };
    expect(validate(bad)).toBe(false);
  });
});
