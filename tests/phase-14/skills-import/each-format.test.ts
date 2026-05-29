import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { importSkill } from '../../../src/skills/import.js';

function freshWs(): string {
  return mkdtempSync(join(tmpdir(), 'yaao-skill-import-'));
}

describe('F14.10 — yaao skills import — per-format', () => {
  it('imports a Claude skill (SKILL.md + frontmatter + sibling tools/)', () => {
    const cwd = freshWs();
    const claudeDir = join(cwd, 'src-claude', 'refactor-react-hooks');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'SKILL.md'),
      [
        '---',
        'name: refactor-react-hooks',
        'description: Refactor a React component to use hooks',
        'allowed-tools: [Read, Edit]',
        '---',
        '',
        'When asked to refactor a component, ...',
      ].join('\n'),
    );
    const toolsDir = join(claudeDir, 'tools');
    mkdirSync(toolsDir);
    writeFileSync(join(toolsDir, 'helper.sh'), '#!/bin/sh\necho hi\n');

    const r = importSkill({
      cwd,
      source: 'src-claude/refactor-react-hooks',
      from: 'claude',
    });
    expect(r.name).toBe('refactor-react-hooks');
    expect(existsSync(join(r.destination, 'skill.yaml'))).toBe(true);
    expect(existsSync(join(r.destination, 'prompt.md'))).toBe(true);
    expect(existsSync(join(r.destination, 'tools', 'helper.sh'))).toBe(true);
    const yaml = parseYaml(readFileSync(join(r.destination, 'skill.yaml'), 'utf8')) as {
      name: string;
      description: string;
      tools: string[];
    };
    expect(yaml.name).toBe('refactor-react-hooks');
    expect(yaml.description).toMatch(/Refactor/);
    expect(yaml.tools).toEqual(['Read', 'Edit']);
    // Prompt body contains the body (without frontmatter) + the audit footer.
    const prompt = readFileSync(join(r.destination, 'prompt.md'), 'utf8');
    expect(prompt).toContain('asked to refactor a component');
    expect(prompt).toMatch(/Imported from .*src-claude\/refactor-react-hooks.*\(claude\)/);
  });

  it('imports a Cursor rule (.mdc with frontmatter; globs → applies-to-files)', () => {
    const cwd = freshWs();
    const path = join(cwd, '.cursor', 'rules', 'tailwind.mdc');
    mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
    writeFileSync(
      path,
      [
        '---',
        'description: Use Tailwind utility-first patterns',
        'globs: ["**/*.tsx", "**/*.jsx"]',
        'alwaysApply: false',
        '---',
        '',
        'Always prefer utility classes.',
      ].join('\n'),
    );
    const r = importSkill({ cwd, source: '.cursor/rules/tailwind.mdc', from: 'cursor' });
    expect(r.name).toBe('tailwind');
    const yaml = parseYaml(readFileSync(join(r.destination, 'skill.yaml'), 'utf8')) as {
      name: string;
      description: string;
      appliesTo: { globs: string[] };
    };
    expect(yaml.description).toMatch(/Tailwind/);
    expect(yaml.appliesTo.globs).toEqual(['**/*.tsx', '**/*.jsx']);
  });

  it('imports Copilot instructions (no frontmatter; broad appliesTo)', () => {
    const cwd = freshWs();
    const path = join(cwd, '.github', 'copilot-instructions.md');
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(path, '# Project conventions\n\nUse TypeScript everywhere.\n');
    const r = importSkill({ cwd, source: '.github/copilot-instructions.md', from: 'copilot' });
    expect(r.name).toBe('github-copilot-instructions');
    const yaml = parseYaml(readFileSync(join(r.destination, 'skill.yaml'), 'utf8')) as {
      name: string;
      description: string;
      appliesTo: { agents: string[] };
    };
    expect(yaml.description).toBe('Project conventions');
    // Broad appliesTo by default for Copilot-style guidance.
    expect(yaml.appliesTo.agents).toEqual([
      'claude-code',
      'cursor',
      'copilot',
      'codex',
      'api',
    ]);
  });

  it('imports Codex AGENTS.md', () => {
    const cwd = freshWs();
    writeFileSync(join(cwd, 'AGENTS.md'), '# Codex agents\n\nGuidance for codex.\n');
    const r = importSkill({ cwd, source: 'AGENTS.md', from: 'codex' });
    expect(r.name).toBe('codex-agents-md');
  });

  it('imports a generic markdown with frontmatter', () => {
    const cwd = freshWs();
    const path = join(cwd, 'my-skill.md');
    writeFileSync(
      path,
      [
        '---',
        'name: my-skill',
        'description: a custom skill',
        'agents: [claude-code, cursor]',
        '---',
        '',
        'Do the thing.',
      ].join('\n'),
    );
    const r = importSkill({ cwd, source: 'my-skill.md', from: 'generic' });
    expect(r.name).toBe('my-skill');
    const yaml = parseYaml(readFileSync(join(r.destination, 'skill.yaml'), 'utf8')) as {
      appliesTo: { agents: string[] };
    };
    expect(yaml.appliesTo.agents).toEqual(['claude-code', 'cursor']);
  });
});

describe('F14.10 — flags and behaviour', () => {
  it('dry-run writes nothing but reports the planned destination', () => {
    const cwd = freshWs();
    const path = join(cwd, '.github', 'copilot-instructions.md');
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(path, '# Guidance\n');
    const r = importSkill({
      cwd,
      source: '.github/copilot-instructions.md',
      from: 'copilot',
      dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(existsSync(r.destination)).toBe(false);
  });

  it('refuses to overwrite an existing yaao skill without --force', () => {
    const cwd = freshWs();
    const path = join(cwd, '.github', 'copilot-instructions.md');
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(path, '# Guidance\n');
    const r1 = importSkill({ cwd, source: '.github/copilot-instructions.md', from: 'copilot' });
    expect(existsSync(r1.destination)).toBe(true);
    expect(() =>
      importSkill({ cwd, source: '.github/copilot-instructions.md', from: 'copilot' }),
    ).toThrow(/already exists/);
  });

  it('--force overwrites an existing yaao skill', () => {
    const cwd = freshWs();
    const path = join(cwd, '.github', 'copilot-instructions.md');
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(path, '# Guidance v1\n');
    importSkill({ cwd, source: '.github/copilot-instructions.md', from: 'copilot' });
    writeFileSync(path, '# Guidance v2\n');
    const r = importSkill({
      cwd,
      source: '.github/copilot-instructions.md',
      from: 'copilot',
      force: true,
    });
    const prompt = readFileSync(join(r.destination, 'prompt.md'), 'utf8');
    expect(prompt).toContain('v2');
  });

  it('--name overrides the derived name', () => {
    const cwd = freshWs();
    const path = join(cwd, '.github', 'copilot-instructions.md');
    mkdirSync(join(cwd, '.github'), { recursive: true });
    writeFileSync(path, '# Guidance\n');
    const r = importSkill({
      cwd,
      source: '.github/copilot-instructions.md',
      from: 'copilot',
      name: 'my-project-conventions',
    });
    expect(r.name).toBe('my-project-conventions');
    expect(r.destination).toMatch(/my-project-conventions$/);
  });

  it('auto-detects format from the path', () => {
    const cwd = freshWs();
    const path = join(cwd, '.cursor', 'rules', 'tailwind.mdc');
    mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true });
    writeFileSync(path, '---\ndescription: x\n---\n\nBody.\n');
    const r = importSkill({ cwd, source: '.cursor/rules/tailwind.mdc' });
    expect(r.format).toBe('cursor');
  });
});
