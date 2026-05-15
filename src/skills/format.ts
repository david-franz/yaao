import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { AGENT_NAMES } from '../config/types.js';
import { YaaoError } from '../log/errors.js';

const SLUG_RE = /^[a-z][a-z0-9-_]*$/;

export const SkillInputSchema = z.object({
  name: z.string().regex(SLUG_RE),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
});

export const SkillMetadataSchema = z
  .object({
    name: z.string().regex(SLUG_RE),
    version: z.number().int().positive().default(1),
    description: z.string().min(1),
    appliesTo: z
      .object({
        agents: z.array(z.enum(AGENT_NAMES)).default([...AGENT_NAMES]),
        globs: z.array(z.string()).default([]),
        dirs: z.array(z.string()).default([]),
      })
      .default({}),
    tools: z.array(z.string()).default([]),
    inputs: z.array(SkillInputSchema).default([]),
    trigger: z
      .object({
        manual: z.boolean().default(true),
        matchPath: z.array(z.string()).default([]),
      })
      .default({}),
  })
  .strict();

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
export type SkillInput = z.infer<typeof SkillInputSchema>;

export interface LoadedSkill {
  metadata: SkillMetadata;
  prompt: string;
  examples: { name: string; body: string }[];
  /** Directory the skill was loaded from. */
  origin: string;
}

export interface SkillLoadOptions {
  /** Project root used to locate `.yaao/skills/`. */
  cwd: string;
  /** Skip ~/.yaao lookups (useful for tests). */
  skipUser?: boolean;
  /** Override the built-in skills directory (defaults to dist/skills next to the package). */
  builtinDir?: string;
}

/**
 * Resolve a skill by name across project → user → built-in roots. Returns the loaded
 * skill plus the directory it came from for diagnostics.
 */
export function resolveSkill(name: string, opts: SkillLoadOptions): LoadedSkill | undefined {
  for (const dir of candidateDirs(name, opts)) {
    if (!existsSync(dir)) continue;
    const loaded = loadSkillDir(dir);
    if (loaded) return loaded;
  }
  return undefined;
}

export function listSkillDirs(opts: SkillLoadOptions): { name: string; dir: string; source: 'project' | 'user' | 'builtin' }[] {
  const out: { name: string; dir: string; source: 'project' | 'user' | 'builtin' }[] = [];
  const sources: [string, 'project' | 'user' | 'builtin'][] = [
    [join(resolve(opts.cwd), '.yaao', 'skills'), 'project'],
  ];
  if (!opts.skipUser) sources.push([join(homedir(), '.yaao', 'skills'), 'user']);
  if (opts.builtinDir) sources.push([opts.builtinDir, 'builtin']);

  const seen = new Set<string>();
  for (const [root, source] of sources) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, dir, source });
    }
  }
  return out;
}

function* candidateDirs(name: string, opts: SkillLoadOptions): Generator<string> {
  yield join(resolve(opts.cwd), '.yaao', 'skills', name);
  if (!opts.skipUser) yield join(homedir(), '.yaao', 'skills', name);
  if (opts.builtinDir) yield join(opts.builtinDir, name);
}

export function loadSkillDir(dir: string): LoadedSkill | undefined {
  const yamlPath = join(dir, 'skill.yaml');
  const promptPath = join(dir, 'prompt.md');
  if (!existsSync(yamlPath) || !existsSync(promptPath)) return undefined;
  const raw = parseYaml(readFileSync(yamlPath, 'utf8')) as unknown;
  const parsed = SkillMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new YaaoError({
      code: 'YAAO_SKILL_INVALID',
      message: `skill.yaml at ${dir} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    });
  }
  const prompt = readFileSync(promptPath, 'utf8');
  const examples: { name: string; body: string }[] = [];
  const exDir = join(dir, 'examples');
  if (existsSync(exDir)) {
    for (const f of readdirSync(exDir)) {
      if (!f.endsWith('.md')) continue;
      examples.push({ name: f.replace(/\.md$/, ''), body: readFileSync(join(exDir, f), 'utf8') });
    }
  }
  return { metadata: parsed.data, prompt, examples, origin: dir };
}

export interface ValidateResult {
  ok: boolean;
  issues: { code: string; message: string }[];
}

export function validateSkill(skill: LoadedSkill, opts: { allowLarge?: boolean } = {}): ValidateResult {
  const issues: { code: string; message: string }[] = [];
  for (const input of skill.metadata.inputs) {
    const placeholder = `{{${input.name}}}`;
    if (!skill.prompt.includes(placeholder)) {
      issues.push({
        code: 'YAAO_SKILL_UNREFERENCED_INPUT',
        message: `input '${input.name}' declared but ${placeholder} not found in prompt.md`,
      });
    }
  }
  const placeholderRe = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;
  const declared = new Set(skill.metadata.inputs.map((i) => i.name));
  let match: RegExpExecArray | null;
  while ((match = placeholderRe.exec(skill.prompt))) {
    const name = match[1];
    if (name && !declared.has(name)) {
      issues.push({
        code: 'YAAO_SKILL_UNDECLARED_PLACEHOLDER',
        message: `prompt.md references {{${name}}} but no matching input is declared`,
      });
    }
  }
  if (!opts.allowLarge && skill.prompt.length > 10_000) {
    issues.push({
      code: 'YAAO_SKILL_PROMPT_TOO_LARGE',
      message: `prompt.md is ${skill.prompt.length} bytes; pass --allow-large to permit > 10 KB`,
    });
  }
  return { ok: issues.length === 0, issues };
}

/** Substitute `{{name}}` placeholders. Missing names use the input's `default` or are left as-is. */
export function substitutePlaceholders(
  prompt: string,
  values: Record<string, string>,
  inputs: SkillInput[] = [],
): string {
  const defaults = new Map<string, string | undefined>();
  for (const i of inputs) defaults.set(i.name, i.default);
  return prompt.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_full, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name] ?? '';
    return defaults.get(name) ?? `{{${name}}}`;
  });
}
