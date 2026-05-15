import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LoadedSkill } from '../format.js';
import { upsertBlock, removeBlock } from '../managed-block.js';

export interface EmitOptions {
  cwd: string;
  force?: boolean;
}

export interface EmitResult {
  files: { path: string; changed: boolean }[];
}

const AGENTS_FILE = 'AGENTS.md';
const OVERLAY_FILE = join('.yaao', 'codex-mcp-overlay.toml');

export function emitCodex(skills: LoadedSkill[], opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const applicable = skills.filter((s) => s.metadata.appliesTo.agents.includes('codex'));
  const out: EmitResult = { files: [] };
  if (applicable.length === 0) return out;

  // 1) Codex TOML overlay (yaao-owned, regenerated wholesale).
  const overlayPath = join(cwd, OVERLAY_FILE);
  mkdirSync(dirname(overlayPath), { recursive: true });
  const desired = renderTomlOverlay();
  const overlayExisting = existsSync(overlayPath) ? readFileSync(overlayPath, 'utf8') : '';
  if (desired !== overlayExisting) writeFileSync(overlayPath, desired);
  out.files.push({ path: OVERLAY_FILE, changed: desired !== overlayExisting });

  // 2) AGENTS.md managed blocks.
  const agentsPath = join(cwd, AGENTS_FILE);
  let body = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  let changed = false;
  for (const skill of applicable) {
    const block = upsertBlock(
      body,
      {
        name: skill.metadata.name,
        version: skill.metadata.version,
        body: renderCodexBlock(skill),
      },
      { ...(opts.force !== undefined ? { force: opts.force } : {}) },
    );
    body = block.text;
    changed = changed || block.changed;
  }
  if (changed || !existsSync(agentsPath)) writeFileSync(agentsPath, body);
  out.files.push({ path: AGENTS_FILE, changed: changed || !existsSync(agentsPath) });
  return out;
}

export function removeCodexSkill(name: string, opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const out: EmitResult = { files: [] };
  const agentsPath = join(cwd, AGENTS_FILE);
  if (existsSync(agentsPath)) {
    const r = removeBlock(readFileSync(agentsPath, 'utf8'), name);
    if (r.removed) writeFileSync(agentsPath, r.text);
    out.files.push({ path: AGENTS_FILE, changed: r.removed });
  }
  return out;
}

export function renderTomlOverlay(): string {
  return [
    '# Managed by yaao — applied at codex spawn time via --config.',
    '[mcp_servers.yaao]',
    'command = "yaao"',
    'args = ["serve", "--stdio"]',
    '',
  ].join('\n');
}

function renderCodexBlock(skill: LoadedSkill): string {
  const inputs = skill.metadata.inputs.length === 0
    ? '`{}`'
    : `\`{ ${skill.metadata.inputs.map((i) => `${i.name}${i.required === false ? '?' : ''}`).join(', ')} }\``;
  return `## ${skill.metadata.name}\n\n${skill.metadata.description} Call MCP tool \`yaao_skill_${skill.metadata.name}\` with ${inputs}.`;
}
