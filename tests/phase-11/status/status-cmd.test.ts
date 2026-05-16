import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../helpers/cli.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

function writeSummary(project: ReturnType<typeof createTmpProject>, runId: string) {
  const dir = join(project.path, '.yaao', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      runId,
      planFile: 'plan.yaml',
      planHash: 'h',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:10Z',
      status: 'success',
      tasks: {
        a: { status: 'completed', agent: 'claude-code', branch: 'p/a', durationMs: 1234 },
      },
    }),
  );
  // jsonl too so loadRun finds the events file
  writeFileSync(join(dir, 'journal.jsonl'), '');
}

describe('yaao status', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('text mode prints the status table', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    writeSummary(project, 'r1');
    const r = await runCli(['--cwd', project.path, 'status', 'r1']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('run r1');
    expect(r.stdout).toContain('a');
    expect(r.stdout).toContain('completed');
  });

  it('--json emits the RunSummary', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    writeSummary(project, 'r2');
    const r = await runCli(['--cwd', project.path, '--json', 'status', 'r2']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as { runId: string; status: string };
    expect(parsed.runId).toBe('r2');
    expect(parsed.status).toBe('success');
  });

  it('--task prints the output log when present', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    writeSummary(project, 'r3');
    project.write('.yaao/runs/r3/a/output.log', 'line one\nline two\n');
    const r = await runCli(['--cwd', project.path, 'status', 'r3', '--task', 'a']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('line one');
    expect(r.stdout).toContain('line two');
  });
});
