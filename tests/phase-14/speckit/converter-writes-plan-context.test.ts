import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { convertPlan } from '../../../src/converter/convert.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';

describe('F14.5 — yaao convert writes plan.context from Spec Kit content', () => {
  it('emits plan.context with spec.md and plan.md content concatenated', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-convert-speckit-'));
    const tripletDir = join(cwd, 'my-feature');
    mkdirSync(tripletDir, { recursive: true });
    writeFileSync(
      join(tripletDir, 'spec.md'),
      '# My Feature — Spec\n\nWe build a thing.\n\n## Constraints\n\n- No Postgres.\n',
    );
    writeFileSync(
      join(tripletDir, 'plan.md'),
      '# My Feature — Plan\n\nWe use SQLite + Drizzle.\n',
    );
    writeFileSync(
      join(tripletDir, 'tasks.md'),
      '# My Feature — Tasks\n\n- [ ] **scaffold** — Scaffold project\n',
    );
    const result = await convertPlan({
      cwd,
      input: tripletDir,
      config: DEFAULT_CONFIG,
    });
    const yaml = readFileSync(result.outPath, 'utf8');
    const parsed = parseYaml(yaml) as { plan: { context?: string } };
    expect(parsed.plan.context).toBeDefined();
    expect(parsed.plan.context).toContain('From spec.md');
    expect(parsed.plan.context).toContain('No Postgres');
    expect(parsed.plan.context).toContain('From plan.md');
    expect(parsed.plan.context).toContain('SQLite + Drizzle');
  });

  it('omits plan.context when converting a markdown-only plan (no spec/plan bodies)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-convert-markdown-'));
    const planFile = join(cwd, 'p.md');
    writeFileSync(
      planFile,
      [
        '# My Plan',
        '',
        '> A description.',
        '',
        '## Tasks',
        '',
        '| id | title | depends | agent | model |',
        '| --- | --- | --- | --- | --- |',
        '| a  | A     |         | claude-code | opus |',
        '',
        '## a — A',
        '',
        'Body of a',
      ].join('\n'),
    );
    const result = await convertPlan({
      cwd,
      input: planFile,
      config: DEFAULT_CONFIG,
    });
    const yaml = readFileSync(result.outPath, 'utf8');
    const parsed = parseYaml(yaml) as { plan: { context?: string } };
    expect(parsed.plan.context).toBeUndefined();
  });
});
