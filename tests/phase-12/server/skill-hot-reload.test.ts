import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMcpServer,
  reconcileSkillTools,
  startSkillWatcher,
} from '../../../src/mcp/server.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

interface SdkInternals {
  _registeredTools: Record<string, { enabled: boolean }>;
}

function liveSkillTools(server: ReturnType<typeof buildMcpServer>): string[] {
  const internals = server as unknown as SdkInternals;
  return Object.entries(internals._registeredTools)
    .filter(([name, t]) => name.startsWith('yaao_skill_') && t.enabled)
    .map(([name]) => name)
    .sort();
}

function writeSkill(root: string, name: string, prompt: string): void {
  const dir = join(root, '.yaao', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'skill.yaml'),
    `name: ${name}\nversion: 1\ndescription: a test skill\ninputs: []\n`,
  );
  writeFileSync(join(dir, 'prompt.md'), prompt);
}

function untilLiveTools(
  server: ReturnType<typeof buildMcpServer>,
  predicate: (tools: string[]) => boolean,
  // Generous default: macOS `fs.watch` cold-start can take a few hundred ms
  // before FSEvents are primed, and shared CI machines under load add jitter
  // on top. Production users don't write skills microseconds after starting
  // `yaao serve` — this generosity is purely test-stability.
  timeoutMs = 5_000,
): Promise<string[]> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const tools = liveSkillTools(server);
      if (predicate(tools)) return resolve(tools);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out; saw ${tools.join(',')}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('F12.6 skill hot reload', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('reconcileSkillTools adds a tool for a newly-written skill', () => {
    project = createTmpProject();
    const server = buildMcpServer({ cwd: project.path, config: DEFAULT_CONFIG });
    const before = liveSkillTools(server);
    writeSkill(project.path, 'fresh', '# fresh\n');
    const r = reconcileSkillTools(server);
    expect(r.added).toContain('fresh');
    const after = liveSkillTools(server);
    expect(after).toContain('yaao_skill_fresh');
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('reconcileSkillTools removes a tool when its skill directory disappears', () => {
    project = createTmpProject();
    writeSkill(project.path, 'doomed', '# doomed\n');
    const server = buildMcpServer({ cwd: project.path, config: DEFAULT_CONFIG });
    expect(liveSkillTools(server)).toContain('yaao_skill_doomed');
    rmSync(join(project.path, '.yaao', 'skills', 'doomed'), { recursive: true, force: true });
    const r = reconcileSkillTools(server);
    expect(r.removed).toContain('doomed');
    expect(liveSkillTools(server)).not.toContain('yaao_skill_doomed');
  });

  it('the watcher reconciles automatically when a skill is written under .yaao/skills/', async () => {
    project = createTmpProject();
    // Pre-create the watched root so fs.watch can latch on; the watcher
    // tolerates a missing root by no-op-ing.
    mkdirSync(join(project.path, '.yaao', 'skills'), { recursive: true });
    const server = buildMcpServer({ cwd: project.path, config: DEFAULT_CONFIG });
    // Tighten the debounce so the test doesn't have to wait the 250 ms default.
    const watcher = startSkillWatcher(server, { cwd: project.path, debounceMs: 10, skipUser: true });
    try {
      // Give macOS FSEvents a moment to actually prime the watcher before the
      // first write. Without this brief settle the test occasionally races —
      // fs.watch returns synchronously but the underlying notification source
      // isn't immediately live.
      await new Promise((r) => setTimeout(r, 100));
      writeSkill(project.path, 'late-arrival', '# late\n');
      const tools = await untilLiveTools(server, (t) => t.includes('yaao_skill_late-arrival'));
      expect(tools).toContain('yaao_skill_late-arrival');
    } finally {
      watcher.stop();
    }
  });

  it('the watcher is idempotent across start/stop and absent skill roots', () => {
    project = createTmpProject();
    const server = buildMcpServer({ cwd: project.path, config: DEFAULT_CONFIG });
    // No `.yaao/skills/` exists. Should not throw.
    const w = startSkillWatcher(server, { cwd: project.path, debounceMs: 1, skipUser: true });
    w.start(); // second start — must be a no-op
    w.stop();
    w.stop(); // second stop — must be a no-op
    expect(existsSync(join(project.path, '.yaao', 'skills'))).toBe(false);
  });
});
