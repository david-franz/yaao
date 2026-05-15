import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCtxSysHook } from '../../../src/ctx-sys/hooks.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('installCtxSysHook with a pre-existing hook', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('appends the managed block without disturbing user content', () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    mkdirSync(join(project.path, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      join(project.path, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh
echo "user pre-commit"
exit 0
`,
    );
    const r = installCtxSysHook({ cwd: project.path });
    expect(r.status).toBe('installed');
    const hook = readFileSync(join(project.path, '.git', 'hooks', 'pre-commit'), 'utf8');
    expect(hook).toContain('user pre-commit');
    expect(hook).toContain('# >>> yaao-ctx-sys');
  });
});
