import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { PlanSchema } from '../../../src/plan/schema/plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

function loadExample(name: string): unknown {
  return parse(readFileSync(join(root, 'examples', name), 'utf8'));
}

describe('PlanSchema valid cases', () => {
  it('accepts examples/oauth.yaml', () => {
    const parsed = PlanSchema.parse(loadExample('oauth.yaml'));
    expect(parsed.plan.name).toBe('oauth');
    expect(parsed.tasks.length).toBe(4);
  });

  it('accepts examples/minimal.yaml', () => {
    const parsed = PlanSchema.parse(loadExample('minimal.yaml'));
    expect(parsed.tasks[0]?.id).toBe('hello');
  });

  it('accepts a task with prompt-ref instead of prompt', () => {
    const yaml = parse(`
plan:
  name: ref
  version: 1
tasks:
  - id: a
    title: A
    agent: claude-code
    prompt-ref: ./prompt.md
`);
    expect(() => PlanSchema.parse(yaml)).not.toThrow();
  });

  it('defaults depends, skills, files, env to empty arrays/objects', () => {
    const parsed = PlanSchema.parse(loadExample('minimal.yaml'));
    expect(parsed.tasks[0]?.depends).toEqual([]);
    expect(parsed.tasks[0]?.skills).toEqual([]);
    expect(parsed.tasks[0]?.files).toEqual([]);
    expect(parsed.tasks[0]?.env).toEqual({});
    expect(parsed.tasks[0]?.retries).toBe(0);
  });
});
