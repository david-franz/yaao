import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { yaaoStopTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('yaao_stop MCP tool', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('returns ok=true with a warning when the run has no runner.pid (already ended)', async () => {
    project = createTmpProject();
    mkdirSync(join(project.path, '.yaao', 'runs', 'r1'), { recursive: true });
    const ctx: ToolContext = { cwd: project.path, config: DEFAULT_CONFIG };
    const r = await yaaoStopTool({ runId: 'r1' }, ctx);
    const sc = r.structuredContent as { ok: boolean; signaled: boolean; reason: string; warnings: string[] };
    expect(sc.ok).toBe(true);
    expect(sc.signaled).toBe(false);
    expect(sc.reason).toBe('no-pid-file');
    expect(sc.warnings).toContain('r1 was not running');
  });

  it('returns ok=true with reason=pid-dead for a stale pid', async () => {
    project = createTmpProject();
    const runDir = join(project.path, '.yaao', 'runs', 'r2');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'runner.pid'), '999999999\n');
    const ctx: ToolContext = { cwd: project.path, config: DEFAULT_CONFIG };
    const r = await yaaoStopTool({ runId: 'r2' }, ctx);
    const sc = r.structuredContent as { ok: boolean; signaled: boolean; reason: string; pid: number };
    expect(sc.ok).toBe(true);
    expect(sc.signaled).toBe(false);
    expect(sc.reason).toBe('pid-dead');
    expect(sc.pid).toBe(999999999);
  });
});
