import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectCtxSys } from '../../../src/ctx-sys/detect.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('detectCtxSys: index state', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reports indexed=false with a clear reason when the DB is missing', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    mkdirSync(join(project.path, '.ctx-sys'), { recursive: true });
    const r = await detectCtxSys({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      bin: '/nonexistent/ctx-sys',
    });
    expect(r.initialized).toBe(true);
    expect(r.indexed).toBe(false);
    expect(r.reason).toMatch(/index is empty/);
  });

  it('reports indexed=true when the DB file has bytes', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    mkdirSync(join(project.path, '.ctx-sys'), { recursive: true });
    writeFileSync(join(project.path, '.ctx-sys', 'db.sqlite'), 'sqlite-bytes');
    const r = await detectCtxSys({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      bin: '/nonexistent/ctx-sys',
    });
    expect(r.indexed).toBe(true);
  });
});
