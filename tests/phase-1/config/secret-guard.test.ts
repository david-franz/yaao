import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../../../src/config/loader.js';
import { LiteralSecretError } from '../../../src/log/errors.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('literal-secret guard', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('rejects a literal api-key in non-secret config', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write(
      '.yaao/yaao.config.json',
      JSON.stringify({
        version: 1,
        agents: { api: { providers: { anthropic: { 'api-key': 'sk-literal-abc123' } } } },
      }),
    );
    await expect(loadConfig({ cwd: project.path, env: {} })).rejects.toBeInstanceOf(
      LiteralSecretError,
    );
  });

  it('accepts a literal api-key in secrets.local.json', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write('.yaao/yaao.config.json', JSON.stringify({ version: 1 }));
    project.write(
      '.yaao/secrets.local.json',
      JSON.stringify({
        agents: { api: { providers: { anthropic: { 'api-key': 'sk-only-here' } } } },
      }),
    );
    const { config } = await loadConfig({ cwd: project.path, env: {} });
    expect(config.agents.api.providers['anthropic']?.['api-key']).toBe('sk-only-here');
  });

  it('reports the offending file and json path', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write(
      '.yaao/yaao.config.json',
      JSON.stringify({
        version: 1,
        agents: { api: { providers: { openai: { 'api-key': 'literal' } } } },
      }),
    );
    try {
      await loadConfig({ cwd: project.path, env: {} });
    } catch (e) {
      const err = e as LiteralSecretError;
      expect(err).toBeInstanceOf(LiteralSecretError);
      expect(err.jsonPath).toBe('agents.api.providers.openai.api-key');
      expect(err.file).toContain('yaao.config.json');
      return;
    }
    throw new Error('expected LiteralSecretError');
  });
});
