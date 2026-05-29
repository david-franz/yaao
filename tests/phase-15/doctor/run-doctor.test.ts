import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../../../src/doctor/index.js';
import { ConfigSchema } from '../../../src/config/schema.js';

function freshWs(): string {
  return mkdtempSync(join(tmpdir(), 'yaao-doctor-'));
}

describe('F15.1 — runDoctor end-to-end', () => {
  it('returns a deterministic DoctorReport with grouped checks', async () => {
    const cwd = freshWs();
    const config = ConfigSchema.parse({ version: 1 });
    const report = await runDoctor({ cwd, config });
    expect(report.yaao).toMatch(/\d+\.\d+\.\d+/);
    expect(report.node).toMatch(/^v\d+\./);
    expect(report.summary.ok + report.summary.warnings + report.summary.errors).toBe(
      report.checks.length,
    );
    // Every check is grouped into one of the documented categories.
    const groups = new Set(report.checks.map((c) => c.group));
    for (const g of groups) {
      expect(['runtime', 'project', 'agents', 'api', 'runs']).toContain(g);
    }
  });

  it("warns when .yaao/ is missing", async () => {
    const cwd = freshWs();
    const config = ConfigSchema.parse({ version: 1 });
    const report = await runDoctor({ cwd, config });
    const projectCheck = report.checks.find((c) => c.name === '.yaao/ initialized');
    expect(projectCheck?.severity).toBe('warning');
    expect(projectCheck?.hint).toMatch(/yaao init/);
  });

  it("reports 'disabled in yaao.config.json (skipped)' for disabled agents", async () => {
    const cwd = freshWs();
    const config = ConfigSchema.parse({
      version: 1,
      agents: { cursor: { enabled: false } },
    });
    const report = await runDoctor({ cwd, config });
    const cursor = report.checks.find((c) => c.group === 'agents' && c.name === 'cursor');
    expect(cursor?.severity).toBe('ok');
    expect(cursor?.message).toMatch(/disabled/);
  });

  it('reports a warning per api provider without a resolvable key', async () => {
    const cwd = freshWs();
    const config = ConfigSchema.parse({
      version: 1,
      agents: { api: { providers: { openai: { 'api-key': '' } } } },
    });
    const report = await runDoctor({ cwd, config });
    const openai = report.checks.find((c) => c.group === 'api' && c.name === 'openai');
    expect(openai?.severity).toBe('warning');
    expect(openai?.hint).toMatch(/OPENAI_API_KEY/);
  });

  it('reports ok when an api provider has a resolvable key', async () => {
    const cwd = freshWs();
    const config = ConfigSchema.parse({
      version: 1,
      agents: { api: { providers: { anthropic: { 'api-key': 'sk-test' } } } },
    });
    const report = await runDoctor({ cwd, config });
    const anth = report.checks.find((c) => c.group === 'api' && c.name === 'anthropic');
    expect(anth?.severity).toBe('ok');
  });

  it('flags an orphaned run', async () => {
    const cwd = freshWs();
    const runsDir = join(cwd, '.yaao', 'runs', 'run-ghost');
    mkdirSync(runsDir, { recursive: true });
    // Build a minimal journal that reports status=running but has stale mtime.
    const journal = join(runsDir, 'journal.jsonl');
    writeFileSync(
      journal,
      JSON.stringify({ t: 'run:start', runId: 'run-ghost', time: new Date().toISOString() }) + '\n',
    );
    const oldMtime = (Date.now() - 5 * 60_000) / 1000;
    // Backdate the journal so the doctor sees it as stale.
    const { utimesSync } = await import('node:fs');
    utimesSync(journal, oldMtime, oldMtime);
    // No runner.pid → orphaned by definition.
    const config = ConfigSchema.parse({ version: 1 });
    const report = await runDoctor({ cwd, config });
    const ghost = report.checks.find((c) => c.group === 'runs' && c.name === 'run-ghost');
    expect(ghost?.severity).toBe('warning');
    expect(ghost?.hint).toMatch(/yaao_prune|yaao status/);
  });
});
