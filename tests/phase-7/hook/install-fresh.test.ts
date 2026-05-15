import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCtxSysHook, HOOK_BEGIN, HOOK_END } from '../../../src/ctx-sys/hooks.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('installCtxSysHook on a fresh repo', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes a managed block when no pre-commit hook exists', () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = installCtxSysHook({ cwd: project.path });
    expect(r.status).toBe('installed');
    const hook = readFileSync(join(project.path, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain(HOOK_BEGIN);
    expect(hook).toContain(HOOK_END);
  });

  it('rerunning is idempotent (status: unchanged)', () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    installCtxSysHook({ cwd: project.path });
    const r = installCtxSysHook({ cwd: project.path });
    expect(r.status).toBe('unchanged');
    // No duplicate blocks
    const hook = readFileSync(join(project.path, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook.split(HOOK_BEGIN)).toHaveLength(2); // one occurrence
  });

  it('skips cleanly when there is no .git directory', () => {
    project = createTmpProject();
    const r = installCtxSysHook({ cwd: project.path });
    expect(r.status).toBe('no-git');
    expect(existsSync(join(project.path, '.git'))).toBe(false);
  });
});
