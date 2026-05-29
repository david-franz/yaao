import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { stringify as stringifyYaml, parse as parseYamlText } from 'yaml';
import { loadSkillDir, validateSkill, type LoadedSkill, type SkillMetadata } from './format.js';
import { YaaoError } from '../log/errors.js';

/**
 * F14.10 — Cross-provider skill import.
 *
 * Converts agent-native skill formats into yaao's portable
 * `skill.yaml` + `prompt.md` shape so a single-provider library
 * becomes callable from every yaao-supported agent via the MCP
 * `yaao_skill_<name>` tool. Five supported source formats:
 *
 *   - claude  — .claude/skills/<name>/SKILL.md with YAML frontmatter
 *   - cursor  — .cursor/rules/<name>.mdc (single file, frontmatter)
 *   - copilot — .github/copilot-instructions.md (single file, no
 *               frontmatter; broad appliesTo by default)
 *   - codex   — AGENTS.md (single file at project root)
 *   - generic — any .md with a YAML frontmatter block
 *
 * The importer is read-side only — it never modifies the source
 * artifact. Output is always written to `.yaao/skills/<name>/` (or
 * `~/.yaao/skills/<name>/`) atomically (via temp-dir rename) so a
 * kill mid-import doesn't leave a half-written directory.
 */

export type SkillSourceFormat = 'claude' | 'cursor' | 'copilot' | 'codex' | 'generic';
export type SkillImportScope = 'project' | 'user';

export interface SkillImportOptions {
  /** Workspace root used to resolve scope: 'project' destinations. */
  cwd: string;
  /** Source path on disk (a SKILL.md, an .mdc, a single .md file, or a
   * Claude skill directory containing SKILL.md). */
  source: string;
  /** Force a specific source format; otherwise auto-detected from the path. */
  from?: SkillSourceFormat | 'auto';
  /** Override the derived skill name. */
  name?: string;
  /** Write target: .yaao/skills/ (default) or ~/.yaao/skills/. */
  scope?: SkillImportScope;
  /** When true, print what would happen without writing anything. */
  dryRun?: boolean;
  /** When true, overwrite an existing yaao skill directory at the same name. */
  force?: boolean;
  /** When true, skip the post-import `yaao skills install` re-emit. */
  noInstall?: boolean;
}

export interface ImportedFile {
  rel: string;
  bytes: number;
}

export interface SkillImportResult {
  name: string;
  format: SkillSourceFormat;
  destination: string;
  scope: SkillImportScope;
  written: ImportedFile[];
  skipped: boolean;
  validation: { ok: boolean; issues: { code: string; message: string }[] };
  /** True when the result reflects a --dry-run; destination + written
   * are populated as they would be on a real run. */
  dryRun: boolean;
}

export function importSkill(opts: SkillImportOptions): SkillImportResult {
  const cwd = resolve(opts.cwd);
  const sourceAbs = resolve(cwd, opts.source);
  if (!existsSync(sourceAbs)) {
    throw new YaaoError({
      code: 'YAAO_SKILL_IMPORT_SOURCE_MISSING',
      message: `source not found: ${sourceAbs}`,
    });
  }
  const format =
    opts.from && opts.from !== 'auto' ? opts.from : detectSourceFormat(sourceAbs);
  const parsed = parseSource(sourceAbs, format);
  const name = normalizeName(opts.name ?? parsed.derivedName ?? '');
  if (!name) {
    throw new YaaoError({
      code: 'YAAO_SKILL_IMPORT_INVALID_NAME',
      message:
        'could not derive a skill name (filename / frontmatter empty or invalid); pass --name <slug>',
    });
  }
  const scope: SkillImportScope = opts.scope ?? 'project';
  const destDir =
    scope === 'project'
      ? join(cwd, '.yaao', 'skills', name)
      : join(homedir(), '.yaao', 'skills', name);

  if (existsSync(destDir) && !opts.force) {
    throw new YaaoError({
      code: 'YAAO_SKILL_IMPORT_EXISTS',
      message: `skill '${name}' already exists at ${destDir}; pass --force to overwrite`,
    });
  }

  // Build the in-memory skill artifact + sibling files.
  const today = '2026-05-29';
  const footer = `\n\n## Imported from ${truncate(opts.source, 120)} (${format}) on ${today}\n`;
  const promptBody = `${parsed.body.trim()}${footer}`;
  const metadata: Partial<SkillMetadata> & { name: string; description: string; version: number } = {
    name,
    version: 1,
    description: parsed.description || `Imported from ${format}: ${name}`,
    appliesTo: {
      agents: parsed.appliesToAgents ?? ['claude-code', 'cursor', 'copilot', 'codex', 'api'],
      globs: parsed.applyToFiles ?? [],
      dirs: [],
    },
    tools: parsed.tools ?? [],
    inputs: [],
    trigger: { manual: true, matchPath: [] },
  };

  const written: ImportedFile[] = [];
  const skillYaml = stringifyYaml(metadata);
  const promptMd = promptBody;
  written.push({ rel: 'skill.yaml', bytes: Buffer.byteLength(skillYaml) });
  written.push({ rel: 'prompt.md', bytes: Buffer.byteLength(promptMd) });
  // Sibling files from Claude skill directories (tools/, references/, etc.)
  const siblings = collectSiblings(sourceAbs, format);
  for (const s of siblings) written.push({ rel: s.rel, bytes: s.bytes });

  if (opts.dryRun) {
    return {
      name,
      format,
      destination: destDir,
      scope,
      written,
      skipped: false,
      // Synthesize a validation result against an in-memory loaded
      // skill so dry-run still surfaces failures users would hit.
      validation: validateSkill(
        synthesizeLoadedSkill(metadata as SkillMetadata, promptMd, destDir),
      ),
      dryRun: true,
    };
  }

  // Atomic write: stage to <destDir>.tmp-<rand>, then rename. A kill
  // mid-import leaves an orphan tmp dir but never a half-written
  // <destDir>.
  const tmpDir = `${destDir}.import-tmp-${Math.floor(performance.now() * 1000) & 0xffff}`;
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'skill.yaml'), skillYaml);
    writeFileSync(join(tmpDir, 'prompt.md'), promptMd);
    for (const s of siblings) {
      const abs = join(tmpDir, s.rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, s.body);
    }
    // Final swap. The yaao skill format reader walks <destDir> directly,
    // so the rename has to land before any caller tries to load.
    if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
    mkdirSync(dirname(destDir), { recursive: true });
    // Move tmpDir contents to destDir via rename (same parent dir → cheap).
    // Using mkdirSync+writeFile dance for portability across filesystems.
    moveTree(tmpDir, destDir);
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }

  const loaded = loadSkillDir(destDir);
  const validation = loaded ? validateSkill(loaded) : { ok: false, issues: [] };
  return {
    name,
    format,
    destination: destDir,
    scope,
    written,
    skipped: false,
    validation,
    dryRun: false,
  };
}

function moveTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    const stat = statSync(s);
    if (stat.isDirectory()) {
      moveTree(s, d);
    } else {
      writeFileSync(d, readFileSync(s));
    }
  }
}

function synthesizeLoadedSkill(
  metadata: SkillMetadata,
  prompt: string,
  origin: string,
): LoadedSkill {
  return { metadata, prompt, examples: [], origin };
}

interface ParsedSource {
  body: string;
  description: string;
  derivedName?: string;
  appliesToAgents?: ('claude-code' | 'cursor' | 'copilot' | 'codex' | 'api')[];
  applyToFiles?: string[];
  tools?: string[];
}

function parseSource(sourceAbs: string, format: SkillSourceFormat): ParsedSource {
  const stat = statSync(sourceAbs);
  if (format === 'claude') {
    // Claude skill: either a directory containing SKILL.md, or a path
    // pointing directly at a SKILL.md.
    const dir = stat.isDirectory() ? sourceAbs : dirname(sourceAbs);
    const file = stat.isDirectory() ? join(sourceAbs, 'SKILL.md') : sourceAbs;
    if (!existsSync(file)) {
      throw new YaaoError({
        code: 'YAAO_SKILL_IMPORT_NOT_FOUND',
        message: `Claude skill: SKILL.md not found at ${file}`,
      });
    }
    const { frontmatter, body } = parseFrontmatter(readFileSync(file, 'utf8'));
    return {
      body,
      description: (frontmatter['description'] as string | undefined) ?? '',
      derivedName: (frontmatter['name'] as string | undefined) ?? basename(dir),
      tools: Array.isArray(frontmatter['allowed-tools'])
        ? (frontmatter['allowed-tools'] as string[])
        : undefined,
    };
  }
  if (format === 'cursor') {
    const { frontmatter, body } = parseFrontmatter(readFileSync(sourceAbs, 'utf8'));
    const globs = frontmatter['globs'];
    return {
      body,
      description: (frontmatter['description'] as string | undefined) ?? '',
      derivedName: basename(sourceAbs).replace(/\.mdc$/, ''),
      applyToFiles: Array.isArray(globs) ? (globs as string[]) : undefined,
    };
  }
  if (format === 'copilot' || format === 'codex') {
    const body = readFileSync(sourceAbs, 'utf8');
    const firstHeading = extractFirstHeading(body);
    return {
      body,
      description: firstHeading,
      derivedName:
        format === 'copilot' ? 'github-copilot-instructions' : 'codex-agents-md',
      // Broad appliesTo: this is general guidance, not agent-specific.
      appliesToAgents: ['claude-code', 'cursor', 'copilot', 'codex', 'api'],
    };
  }
  // format === 'generic'
  const { frontmatter, body } = parseFrontmatter(readFileSync(sourceAbs, 'utf8'));
  const agents = frontmatter['agents'] ?? frontmatter['applies-to'];
  return {
    body,
    description: (frontmatter['description'] as string | undefined) ?? '',
    derivedName: (frontmatter['name'] as string | undefined) ?? basename(sourceAbs, extname(sourceAbs)),
    appliesToAgents: Array.isArray(agents)
      ? (agents as ('claude-code' | 'cursor' | 'copilot' | 'codex' | 'api')[])
      : undefined,
    tools: Array.isArray(frontmatter['tools']) ? (frontmatter['tools'] as string[]) : undefined,
  };
}

function detectSourceFormat(sourceAbs: string): SkillSourceFormat {
  const lower = sourceAbs.toLowerCase();
  const parts = sourceAbs.split(sep);
  if (lower.endsWith('.mdc') || parts.some((p) => p === '.cursor')) return 'cursor';
  if (lower.endsWith('copilot-instructions.md') || lower.endsWith('copilot-instructions')) return 'copilot';
  if (lower.endsWith('agents.md')) return 'codex';
  // Claude: directory containing SKILL.md, or a SKILL.md path directly.
  if (existsSync(sourceAbs)) {
    const stat = statSync(sourceAbs);
    if (stat.isDirectory() && existsSync(join(sourceAbs, 'SKILL.md'))) return 'claude';
    if (basename(sourceAbs) === 'SKILL.md') return 'claude';
  }
  // Generic fallback
  return 'generic';
}

interface CollectedSibling {
  rel: string;
  body: string;
  bytes: number;
}

function collectSiblings(sourceAbs: string, format: SkillSourceFormat): CollectedSibling[] {
  // Only Claude skill directories carry sibling tools/ + references/ etc.
  if (format !== 'claude') return [];
  const stat = statSync(sourceAbs);
  const dir = stat.isDirectory() ? sourceAbs : dirname(sourceAbs);
  const out: CollectedSibling[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'SKILL.md') continue;
    const abs = join(dir, entry);
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      // Recurse into the subtree.
      for (const f of walkFiles(abs)) {
        const rel = `${entry}/${f.rel}`;
        out.push({ rel, body: f.body, bytes: f.bytes });
      }
    } else {
      const body = readFileSync(abs, 'utf8');
      out.push({ rel: entry, body, bytes: Buffer.byteLength(body) });
    }
  }
  return out;
}

function* walkFiles(root: string): Generator<{ rel: string; body: string; bytes: number }> {
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    let s;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      for (const f of walkFiles(abs)) {
        yield { rel: `${entry}/${f.rel}`, body: f.body, bytes: f.bytes };
      }
    } else {
      const body = readFileSync(abs, 'utf8');
      yield { rel: entry, body, bytes: Buffer.byteLength(body) };
    }
  }
}

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  // YAML frontmatter is delimited by --- on its own line. If absent,
  // there's no frontmatter and the whole text is the body.
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, body: text };
  const block = text.slice(4, end);
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYamlText(block) as unknown;
    if (parsed && typeof parsed === 'object') {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Bad YAML — treat as no frontmatter.
  }
  const body = text.slice(end + '\n---'.length).replace(/^\r?\n/, '');
  return { frontmatter, body };
}

function extractFirstHeading(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  // No heading — fall back to the first non-empty line, truncated.
  for (const line of body.split(/\r?\n/)) {
    if (line.trim().length > 0) return truncate(line.trim(), 120);
  }
  return '';
}

function normalizeName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/\.md(c)?$/, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^([^a-z])/, 's-$1');
  if (!/^[a-z][a-z0-9-_]*$/.test(slug)) return '';
  return slug;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
