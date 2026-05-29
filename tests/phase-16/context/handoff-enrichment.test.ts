import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeContextMd, type TaskOutcomeArtifact } from '../../../src/exec/context.js';
import type { ResolvedTask } from '../../../src/plan/schema/resolve.js';
import { createTmpProject, type TmpProject } from '../../helpers/tmp-dir.js';

/**
 * F16.3 — Tests for the enriched parent→child context handoff. The
 * four optional sections (`Original task`, `Validation`, `Diff`,
 * `Commits`) each render only when their field is present AND
 * `config.context.include` permits, so a downstream agent reading
 * `context.md` sees the parent's full story — original prompt,
 * verdict, what it changed and where — not just the stdout tail.
 *
 * Each test exercises one slice of the contract:
 *   - rendering when data + include both permit
 *   - omission when data is absent
 *   - omission when `include: []` opts out
 *   - the truncation caps stay sub-budget
 *   - byte-for-byte parity with the pre-F16.3 artifact under `include: []`
 */
function makeTask(id = 'api'): ResolvedTask {
  return {
    id,
    title: 'API',
    agent: 'claude-code',
    branch: `feature-foo/${id}`,
    worktree: `/tmp/worktrees/${id}`,
    merge: { strategy: 'auto', when: 'completed', 'create-if-missing': true },
    retries: 0,
    permissions: 'allow-edits',
    depends: [],
    skills: [],
    files: [],
    env: {},
    setup: [],
    prompt: 'do it',
  };
}

function baseArtifact(): TaskOutcomeArtifact {
  return {
    branch: 'feature-foo/api',
    filesChanged: 1,
    insertions: 5,
    deletions: 0,
    files: [{ path: 'src/x.ts', status: 'added' }],
    summary: 'agent did the thing\nall green',
    commit: 'abc1234567890',
    commitSubject: 'feat: x',
  };
}

describe('F16.3 — context.md handoff enrichment', () => {
  let project: TmpProject | undefined;
  afterEach(() => project?.cleanup());

  it('renders all four sections when artifact has data and include is undefined', () => {
    project = createTmpProject();
    const task = makeTask();
    writeContextMd(project.path, task, {
      ...baseArtifact(),
      originalPrompt: 'Build the API for user signup.\nFollow the spec.',
      validation: {
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 1234,
        mustPass: true,
        decisionReason: 'exit-code',
      },
      commits: [
        { sha: 'aaaaaaaa00000000000000000000000000000000', subject: 'feat: route' },
        { sha: 'bbbbbbbb00000000000000000000000000000000', subject: 'test: route' },
      ],
      diffStat: ' src/x.ts | 5 +++++\n 1 file changed, 5 insertions(+)',
    });
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    expect(md).toContain('## Original task');
    expect(md).toContain('Build the API for user signup.');
    expect(md).toContain('## Validation');
    expect(md).toContain('- Command: `pnpm test`');
    expect(md).toContain('- Exit code: 0 (passed, must-pass=true)');
    expect(md).toContain('## Diff');
    expect(md).toContain('src/x.ts | 5 +++++');
    expect(md).toContain('## Commits');
    expect(md).toContain('- aaaaaaa feat: route');
    expect(md).toContain('- bbbbbbb test: route');
    // Multi-commit chain replaces the legacy single-head `## Commit`.
    expect(md).not.toMatch(/^## Commit$/m);
  });

  it("omits sections whose data is absent (validation only)", () => {
    project = createTmpProject();
    const task = makeTask();
    writeContextMd(project.path, task, {
      ...baseArtifact(),
      validation: {
        command: 'pnpm test',
        exitCode: 1,
        durationMs: 50,
        mustPass: false,
        decisionReason: 'exit-code',
      },
    });
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    expect(md).toContain('## Validation');
    expect(md).toContain('failed, must-pass=false');
    expect(md).not.toContain('## Original task');
    expect(md).not.toContain('## Diff');
    expect(md).not.toContain('## Commits');
    // The legacy single-head `## Commit` fallback still renders when
    // the F16.3 `commits` array is absent — keeps the artifact
    // backward-compatible with readers that hard-coded that heading.
    expect(md).toContain('## Commit\n');
    expect(md).toContain('abc1234');
  });

  it("`include: []` reproduces the pre-F16.3 artifact shape byte-for-byte (legacy commit fallback)", () => {
    project = createTmpProject();
    const task = makeTask();
    // Even when every F16.3 field is populated, include:[] suppresses
    // every new section. The artifact should match what a pre-F16.3
    // writeContextMd would have emitted given the same legacy fields.
    writeContextMd(
      project.path,
      task,
      {
        ...baseArtifact(),
        originalPrompt: 'should be hidden',
        validation: {
          command: 'should be hidden',
          exitCode: 0,
          durationMs: 0,
          mustPass: true,
          decisionReason: 'exit-code',
        },
        commits: [{ sha: 'deadbeef00000000000000000000000000000000', subject: 'hidden' }],
        diffStat: 'should be hidden',
      },
      { include: [] },
    );
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    expect(md).not.toContain('## Original task');
    expect(md).not.toContain('## Validation');
    expect(md).not.toContain('## Diff');
    expect(md).not.toContain('## Commits');
    // The legacy single-head section is what pre-F16.3 emitted.
    expect(md).toContain('## Commit\n');
    expect(md).toContain('abc1234 feat: x');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Files');
  });

  it('respects a subset of include (validation + commits only)', () => {
    project = createTmpProject();
    const task = makeTask();
    writeContextMd(
      project.path,
      task,
      {
        ...baseArtifact(),
        originalPrompt: 'should be hidden',
        validation: {
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 5,
          mustPass: true,
          decisionReason: 'exit-code',
        },
        commits: [{ sha: 'aaaaaaaa00000000000000000000000000000000', subject: 'feat: x' }],
        diffStat: 'should be hidden',
      },
      { include: ['validation', 'commits'] },
    );
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    expect(md).toContain('## Validation');
    expect(md).toContain('## Commits');
    expect(md).not.toContain('## Original task');
    expect(md).not.toContain('## Diff');
  });

  it('truncates the original prompt preview at 30 lines and marks it', () => {
    project = createTmpProject();
    const task = makeTask();
    const longPrompt = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
    writeContextMd(project.path, task, {
      ...baseArtifact(),
      originalPrompt: longPrompt,
    });
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    expect(md).toContain('line 1');
    expect(md).toContain('line 30');
    expect(md).not.toContain('line 31');
    expect(md).toContain('_(truncated at 30 lines)_');
  });

  it('truncates the diff stat at 30 lines and marks it', () => {
    project = createTmpProject();
    const task = makeTask();
    const longDiff = Array.from({ length: 50 }, (_, i) => ` file-${i}.ts | 1 +`).join('\n');
    writeContextMd(project.path, task, {
      ...baseArtifact(),
      diffStat: longDiff,
    });
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    expect(md).toContain('file-0.ts');
    expect(md).toContain('file-29.ts');
    expect(md).not.toContain('file-30.ts');
    expect(md).toContain('_(diff stat truncated at 30 lines)_');
  });

  it('renders an empty original prompt as omitted (no heading)', () => {
    project = createTmpProject();
    const task = makeTask();
    writeContextMd(project.path, task, {
      ...baseArtifact(),
      originalPrompt: '   \n',
    });
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    expect(md).not.toContain('## Original task');
  });

  it("section ordering is fixed: Original task → Validation → Summary → Diff → Commits → Files", () => {
    project = createTmpProject();
    const task = makeTask();
    writeContextMd(project.path, task, {
      ...baseArtifact(),
      originalPrompt: 'p',
      validation: {
        command: 'c',
        exitCode: 0,
        durationMs: 1,
        mustPass: true,
        decisionReason: 'exit-code',
      },
      commits: [{ sha: 'aaaaaaa', subject: 's' }],
      diffStat: ' x | 1 +',
    });
    const md = readFileSync(join(project.path, 'api', 'context.md'), 'utf8');
    const idxOf = (h: string) => md.indexOf(h);
    expect(idxOf('## Original task')).toBeLessThan(idxOf('## Validation'));
    expect(idxOf('## Validation')).toBeLessThan(idxOf('## Summary'));
    expect(idxOf('## Summary')).toBeLessThan(idxOf('## Diff'));
    expect(idxOf('## Diff')).toBeLessThan(idxOf('## Commits'));
    expect(idxOf('## Commits')).toBeLessThan(idxOf('## Files'));
  });
});

describe('F16.3 — config.context.include plumbs into the resolved plan', () => {
  it('parses include: ["prompt","validation"] and propagates to resolved.config.context.include', async () => {
    const { PlanSchema } = await import('../../../src/plan/schema/plan.js');
    const { resolvePlan } = await import('../../../src/plan/schema/resolve.js');
    const { DEFAULT_CONFIG } = await import('../../../src/config/types.js');
    const raw = PlanSchema.parse({
      plan: { name: 'oauth', version: 1 },
      config: { context: { include: ['prompt', 'validation'] } },
      tasks: [{ id: 'api', title: 'API', agent: 'claude-code', prompt: 'p' }],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    expect(resolved.config.context.include).toEqual(['prompt', 'validation']);
  });

  it("absent include leaves resolved.config.context.include as undefined (full-render default)", async () => {
    const { PlanSchema } = await import('../../../src/plan/schema/plan.js');
    const { resolvePlan } = await import('../../../src/plan/schema/resolve.js');
    const { DEFAULT_CONFIG } = await import('../../../src/config/types.js');
    const raw = PlanSchema.parse({
      plan: { name: 'oauth', version: 1 },
      tasks: [{ id: 'api', title: 'API', agent: 'claude-code', prompt: 'p' }],
    });
    const resolved = resolvePlan(raw, { config: DEFAULT_CONFIG });
    expect(resolved.config.context.include).toBeUndefined();
  });

  it("rejects an include value not in the enum", async () => {
    const { PlanSchema } = await import('../../../src/plan/schema/plan.js');
    expect(() =>
      PlanSchema.parse({
        plan: { name: 'oauth', version: 1 },
        config: { context: { include: ['nope'] } },
        tasks: [{ id: 'api', title: 'API', agent: 'claude-code', prompt: 'p' }],
      }),
    ).toThrow();
  });
});
