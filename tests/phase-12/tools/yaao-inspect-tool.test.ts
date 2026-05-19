import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execaSync } from 'execa';
import { join } from 'node:path';
import { yaaoInspectTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { openJournal } from '../../../src/git/journal.js';

describe('yaao_inspect MCP tool', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('reports an empty workspace cleanly outside a yaao project layout', async () => {
    repo = createTestRepo();
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoInspectTool({}, ctx);
    expect(r.structuredContent['ok']).toBe(true);
    expect(r.structuredContent['plans']).toEqual([]);
    expect(r.structuredContent['runs']).toEqual([]);
    const ws = r.structuredContent['workspace'] as { inRepo: boolean; baseBranch: string };
    expect(ws.inRepo).toBe(true);
    expect(ws.baseBranch).toBe('main');
  });

  it('joins plan + exec + run state into a single snapshot', async () => {
    repo = createTestRepo();
    // Plan + exec on disk; commit the exec so tracked/planCommit are populated.
    mkdirSync(join(repo.path, '.yaao', 'plans'), { recursive: true });
    mkdirSync(join(repo.path, '.yaao', 'exec'), { recursive: true });
    writeFileSync(join(repo.path, '.yaao', 'plans', 'kheap.md'), '# kheap\n');
    writeFileSync(
      join(repo.path, '.yaao', 'exec', 'kheap.yaml'),
      'plan:\n  name: kheap\n  version: 1\ntasks: []\n',
    );
    repo.commit('add kheap plan + exec');

    // Synthesise a finished run for plan "kheap" using the real journal writer
    // so summary.json is built (listRuns ignores runs without it).
    const journalDir = join(repo.path, '.yaao', 'runs');
    const journal = await openJournal('run-X', { dir: journalDir });
    await journal.append({
      t: 'run:start',
      time: '2026-05-01T00:00:00Z',
      runId: 'run-X',
      planFile: join(repo.path, '.yaao', 'exec', 'kheap.yaml'),
      planHash: 'h',
      config: { baseBranch: 'main', maxParallel: 1 },
    });
    await journal.append({ t: 'task:queued', time: '2026-05-01T00:00:01Z', taskId: 'a', depends: [] });
    await journal.append({ t: 'task:ready', time: '2026-05-01T00:00:02Z', taskId: 'a' });
    await journal.append({
      t: 'task:running',
      time: '2026-05-01T00:00:03Z',
      taskId: 'a',
      agent: 'claude-code',
      worktree: '/tmp/wt',
      branch: 'kheap/a',
      pid: 0,
    });
    await journal.append({
      t: 'task:completed',
      time: '2026-05-01T00:00:04Z',
      taskId: 'a',
      durationMs: 100,
      filesChanged: 1,
      commit: 'c'.repeat(40),
    });
    await journal.append({ t: 'run:end', time: '2026-05-01T00:00:05Z', status: 'success', durationMs: 200 });
    await journal.close();
    // Materialise the actual branch so branchesAlive picks it up.
    execaSync('git', ['branch', 'kheap/a', 'main'], { cwd: repo.path });

    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoInspectTool({}, ctx);
    expect(r.structuredContent['ok']).toBe(true);
    const plans = r.structuredContent['plans'] as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan['slug']).toBe('kheap');
    expect(plan['planPath']).toBe('.yaao/plans/kheap.md');
    expect(plan['execPath']).toBe('.yaao/exec/kheap.yaml');
    expect(plan['tracked']).toBe(true);
    expect(plan['execTracked']).toBe(true);
    expect(plan['planCommit']).toMatch(/^[0-9a-f]{40}$/);
    expect(plan['lastRunId']).toBe('run-X');
    expect(plan['lastRunStatus']).toBe('success');

    const runs = r.structuredContent['runs'] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run['runId']).toBe('run-X');
    expect(run['planSlug']).toBe('kheap');
    expect(run['tasksTotal']).toBe(1);
    expect(run['tasksCompleted']).toBe(1);
    expect(run['branchesAlive']).toEqual(['kheap/a']);
  });

  it('flags an untracked plan as tracked: false', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao', 'plans'), { recursive: true });
    writeFileSync(join(repo.path, '.yaao', 'plans', 'kheap.md'), '# kheap\n');
    // Deliberately no commit.
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoInspectTool({}, ctx);
    const plans = r.structuredContent['plans'] as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    expect(plans[0]?.['tracked']).toBe(false);
    expect(plans[0]?.['planCommit']).toBeNull();
  });

  it('restricts to a single slug when input.slug is set', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao', 'plans'), { recursive: true });
    writeFileSync(join(repo.path, '.yaao', 'plans', 'a.md'), '# a\n');
    writeFileSync(join(repo.path, '.yaao', 'plans', 'b.md'), '# b\n');
    const ctx: ToolContext = { cwd: repo.path, config: DEFAULT_CONFIG };
    const r = await yaaoInspectTool({ slug: 'a' }, ctx);
    const plans = r.structuredContent['plans'] as Array<Record<string, unknown>>;
    expect(plans.map((p) => p['slug'])).toEqual(['a']);
  });
});
