import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../../../src/config/loader.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('loadConfig with no files', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('returns the compiled-in defaults', async () => {
    project = createTmpProject();
    // make the tmp dir look like a repo so the upward walk stops here
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    const { config, paths } = await loadConfig({ cwd: project.path, env: {} });
    expect(paths.project).toBeUndefined();
    expect(config.version).toBe(1);
    expect(config.defaults.agent).toBe('claude-code');
    expect(config.defaults['max-parallel']).toBe(4);
    expect(config['ctx-sys'].enabled).toBe(false);
  });
});
