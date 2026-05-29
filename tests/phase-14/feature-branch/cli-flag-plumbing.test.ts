import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { convertPlan } from '../../../src/converter/convert.js';
import { runPlanner } from '../../../src/planner/run.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import type {
  AgentBackend,
  AgentProcess,
  AvailabilityReport,
  SpawnOptions,
} from '../../../src/agents/backend.js';

function fakeBackend(): AgentBackend {
  return {
    name: 'claude-code',
    isAvailable: async (): Promise<AvailabilityReport> => ({ available: true }),
    spawn: async (_opts: SpawnOptions): Promise<AgentProcess> => {
      throw new Error('fake backend should not be spawned in dry-run');
    },
  };
}

describe('F14.9 — --feature-branch plumbing', () => {
  it('runPlanner with featureBranch threads it into the planner prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-fb-'));
    const config = ConfigSchema.parse({
      version: 1,
      agents: { 'claude-code': { enabled: true } },
    });
    const r = await runPlanner({
      cwd,
      config,
      description: 'add x',
      dryRun: true,
      backend: fakeBackend(),
      featureBranch: 'feat/foo',
    });
    expect(r.prompt).toContain('feat/foo');
    // The {{feature-branch}} placeholder must be substituted, not echoed.
    expect(r.prompt).not.toContain('{{feature-branch}}');
  });

  it('convert --feature-branch writes plan.featureBranch into the YAML', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'yaao-fb-convert-'));
    const planFile = join(cwd, 'p.md');
    writeFileSync(
      planFile,
      [
        '# Test Plan',
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
      featureBranch: 'feat/bar',
    });
    const yaml = readFileSync(result.outPath, 'utf8');
    const parsed = parseYaml(yaml) as { plan: { featureBranch?: string } };
    expect(parsed.plan.featureBranch).toBe('feat/bar');
  });
});
