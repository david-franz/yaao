import { describe, it, expect, afterEach } from 'vitest';
import { detectCtxSys } from '../../../src/ctx-sys/detect.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('detectCtxSys: not installed', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reports installed=false with a reason when the bin is missing', async () => {
    project = createTmpProject();
    const r = await detectCtxSys({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      bin: '/nonexistent/ctx-sys-yaao-test',
    });
    expect(r.installed).toBe(false);
    expect(r.reason).toContain('ctx-sys');
  });

  it('reports initialized=false when .ctx-sys/ is absent', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const r = await detectCtxSys({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      bin: '/nonexistent/ctx-sys',
    });
    expect(r.initialized).toBe(false);
  });
});
