import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LoadedSkill } from '../format.js';
import { upsertBlock, removeBlock } from '../managed-block.js';

export interface EmitOptions {
  cwd: string;
  force?: boolean;
}

export interface EmitResult {
  files: { path: string; changed: boolean; replaced?: boolean }[];
}

const MCP_FILE = join('.claude', 'yaao-mcp.json');
const CLAUDE_MD = join('.claude', 'CLAUDE.md');

export function emitClaudeCode(skills: LoadedSkill[], opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const applicable = skills.filter((s) => s.metadata.appliesTo.agents.includes('claude-code'));
  const out: EmitResult = { files: [] };

  // 1) Always (re)write `.claude/yaao-mcp.json` when there is at least one applicable skill.
  if (applicable.length > 0) {
    const mcpPath = join(cwd, MCP_FILE);
    mkdirSync(dirname(mcpPath), { recursive: true });
    const desired = `${JSON.stringify(
      { mcpServers: { yaao: { command: 'yaao', args: ['serve', '--stdio'] } } },
      null,
      2,
    )}\n`;
    const existing = existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : '';
    if (existing !== desired) writeFileSync(mcpPath, desired);
    out.files.push({ path: MCP_FILE, changed: existing !== desired });
  }

  // 2) Per-skill managed block in `.claude/CLAUDE.md`.
  const claudePath = join(cwd, CLAUDE_MD);
  mkdirSync(dirname(claudePath), { recursive: true });
  let body = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  let anyChange = false;
  let anyReplace = false;
  for (const skill of applicable) {
    const block = upsertBlock(
      body,
      {
        name: skill.metadata.name,
        version: skill.metadata.version,
        body: renderClaudeBlockBody(skill),
      },
      { ...(opts.force !== undefined ? { force: opts.force } : {}) },
    );
    body = block.text;
    anyChange = anyChange || block.changed;
    anyReplace = anyReplace || block.replaced;
  }
  if (anyChange || body.length === 0) {
    writeFileSync(claudePath, body);
  }
  out.files.push({ path: CLAUDE_MD, changed: anyChange, replaced: anyReplace });
  return out;
}

export function removeClaudeCodeSkill(name: string, opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const out: EmitResult = { files: [] };
  const claudePath = join(cwd, CLAUDE_MD);
  if (existsSync(claudePath)) {
    const body = readFileSync(claudePath, 'utf8');
    const r = removeBlock(body, name);
    if (r.removed) writeFileSync(claudePath, r.text);
    out.files.push({ path: CLAUDE_MD, changed: r.removed });
  }
  return out;
}

function renderClaudeBlockBody(skill: LoadedSkill): string {
  const inputs = describeInputs(skill);
  return `## ${skill.metadata.name}\n\n${skill.metadata.description} Call the MCP tool \`yaao_skill_${skill.metadata.name}\` with ${inputs}.`;
}

function describeInputs(skill: LoadedSkill): string {
  if (skill.metadata.inputs.length === 0) return '`{}`';
  const props = skill.metadata.inputs
    .map((i) => `${i.name}${i.required === false ? '?' : ''}`)
    .join(', ');
  return `\`{ ${props} }\``;
}
