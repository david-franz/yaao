import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, deepMerge } from '../../../src/config/loader.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('config layer precedence', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('project config overrides defaults', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write(
      '.yaao/yaao.config.json',
      JSON.stringify({ version: 1, defaults: { 'max-parallel': 8 } }),
    );
    const { config } = await loadConfig({ cwd: project.path, env: {} });
    expect(config.defaults['max-parallel']).toBe(8);
    expect(config.defaults.agent).toBe('claude-code'); // unchanged default
  });

  it('secrets are merged on top of project config', async () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    project.write(
      '.yaao/yaao.config.json',
      JSON.stringify({
        version: 1,
        agents: { api: { providers: { anthropic: { 'api-key': '${ANTHROPIC_API_KEY}' } } } },
      }),
    );
    project.write(
      '.yaao/secrets.local.json',
      JSON.stringify({
        agents: { api: { providers: { openai: { 'api-key': '${OPENAI_API_KEY}' } } } },
      }),
    );
    const { config } = await loadConfig({
      cwd: project.path,
      env: { ANTHROPIC_API_KEY: 'sk-anth', OPENAI_API_KEY: 'sk-oai' },
    });
    expect(config.agents.api.providers['anthropic']?.['api-key']).toBe('sk-anth');
    expect(config.agents.api.providers['openai']?.['api-key']).toBe('sk-oai');
  });
});

describe('deepMerge', () => {
  it('preserves left side keys not present on right', () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });
  it('recurses into plain objects', () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({
      a: { x: 1, y: 3, z: 4 },
    });
  });
  it('right-side arrays replace left-side arrays', () => {
    expect(deepMerge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });
});
