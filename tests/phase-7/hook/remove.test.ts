import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCtxSysHook, removeCtxSysHook } from '../../../src/ctx-sys/hooks.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('removeCtxSysHook', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('strips the managed block but preserves user content', () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write('.git/hooks/pre-commit', '#!/bin/sh\necho "user pre-commit"\nexit 0\n');
    installCtxSysHook({ cwd: project.path });
    const r = removeCtxSysHook({ cwd: project.path });
    expect(r.status).toBe('removed');
    const hook = readFileSync(join(project.path, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('user pre-commit');
    expect(hook).not.toContain('# >>> yaao-ctx-sys');
  });

  it('returns absent when no managed block is present', () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write('.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n');
    const r = removeCtxSysHook({ cwd: project.path });
    expect(r.status).toBe('absent');
  });
});
