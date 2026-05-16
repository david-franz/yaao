import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldProject } from '../../../src/init/scaffold.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

describe('scaffoldProject with detected agents', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes enabled:false for agents the probe reported missing', () => {
    project = createTmpProject();
    project.write('.git/HEAD', 'ref: refs/heads/main\n');
    scaffoldProject({
      cwd: project.path,
      force: false,
      minimal: true,
      detectedAgents: { 'claude-code': true, cursor: false, copilot: false, codex: false },
    });
    const raw = JSON.parse(
      readFileSync(join(project.path, '.yaao', 'yaao.config.json'), 'utf8'),
    ) as { agents: Record<string, { enabled?: boolean }> };
    expect(raw.agents['claude-code']?.enabled).toBe(true);
    expect(raw.agents['cursor']?.enabled).toBe(false);
    expect(raw.agents['copilot']?.enabled).toBe(false);
    expect(raw.agents['codex']?.enabled).toBe(false);
  });

  it('defaults all agents to enabled when no probe results are supplied', () => {
    project = createTmpProject();
    scaffoldProject({ cwd: project.path, force: false, minimal: true });
    const raw = JSON.parse(
      readFileSync(join(project.path, '.yaao', 'yaao.config.json'), 'utf8'),
    ) as { agents: Record<string, { enabled?: boolean }> };
    expect(raw.agents['claude-code']?.enabled).toBe(true);
    expect(raw.agents['cursor']?.enabled).toBe(true);
    expect(raw.agents['copilot']?.enabled).toBe(true);
    expect(raw.agents['codex']?.enabled).toBe(true);
  });
});
