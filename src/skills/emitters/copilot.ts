import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LoadedSkill } from '../format.js';
import { upsertBlock, removeBlock } from '../managed-block.js';

export interface EmitOptions {
  cwd: string;
  force?: boolean;
  /** Override the Copilot MCP config path (default `.vscode/mcp.json`). */
  mcpConfigPath?: string;
}

export interface EmitResult {
  files: { path: string; changed: boolean }[];
}

const INSTRUCTIONS_FILE = join('.github', 'copilot-instructions.md');
const DEFAULT_MCP_PATH = join('.vscode', 'mcp.json');

const YAAO_SERVER = { type: 'stdio', command: 'yaao', args: ['serve', '--stdio'] };

export function emitCopilot(skills: LoadedSkill[], opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const applicable = skills.filter((s) => s.metadata.appliesTo.agents.includes('copilot'));
  const out: EmitResult = { files: [] };
  if (applicable.length === 0) return out;

  // MCP config (default .vscode/mcp.json)
  const mcpRel = opts.mcpConfigPath ?? DEFAULT_MCP_PATH;
  const mcpAbs = join(cwd, mcpRel);
  mkdirSync(dirname(mcpAbs), { recursive: true });
  const mcpExisting = existsSync(mcpAbs) ? readFileSync(mcpAbs, 'utf8') : '';
  const desiredMcp = mergeCopilotMcp(mcpExisting, YAAO_SERVER);
  if (desiredMcp !== mcpExisting) writeFileSync(mcpAbs, desiredMcp);
  out.files.push({ path: mcpRel, changed: desiredMcp !== mcpExisting });

  // copilot-instructions.md managed blocks
  const insAbs = join(cwd, INSTRUCTIONS_FILE);
  mkdirSync(dirname(insAbs), { recursive: true });
  let body = existsSync(insAbs) ? readFileSync(insAbs, 'utf8') : '';
  let changed = false;
  for (const skill of applicable) {
    const block = upsertBlock(
      body,
      {
        name: skill.metadata.name,
        version: skill.metadata.version,
        body: renderCopilotBlock(skill),
      },
      { ...(opts.force !== undefined ? { force: opts.force } : {}) },
    );
    body = block.text;
    changed = changed || block.changed;
  }
  if (changed || !existsSync(insAbs)) writeFileSync(insAbs, body);
  out.files.push({ path: INSTRUCTIONS_FILE, changed: changed || !existsSync(insAbs) });
  return out;
}

export function removeCopilotSkill(name: string, opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const out: EmitResult = { files: [] };
  const insAbs = join(cwd, INSTRUCTIONS_FILE);
  if (existsSync(insAbs)) {
    const r = removeBlock(readFileSync(insAbs, 'utf8'), name);
    if (r.removed) writeFileSync(insAbs, r.text);
    out.files.push({ path: INSTRUCTIONS_FILE, changed: r.removed });
  }
  return out;
}

/**
 * Copilot's MCP config uses `servers:` (not `mcpServers:`). Preserve any existing user
 * entries; replace only the `yaao` entry.
 */
export function mergeCopilotMcp(existing: string, yaaoServer: { type: string; command: string; args: string[] }): string {
  let parsed: { servers?: Record<string, unknown> };
  if (existing.trim().length === 0) {
    parsed = { servers: {} };
  } else {
    try {
      parsed = JSON.parse(existing) as { servers?: Record<string, unknown> };
    } catch {
      parsed = { servers: {} };
    }
  }
  parsed.servers = parsed.servers ?? {};
  parsed.servers['yaao'] = yaaoServer;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function renderCopilotBlock(skill: LoadedSkill): string {
  const inputs = skill.metadata.inputs.length === 0
    ? '`{}`'
    : `\`{ ${skill.metadata.inputs.map((i) => `${i.name}${i.required === false ? '?' : ''}`).join(', ')} }\``;
  return `## ${skill.metadata.name} (yaao MCP)\n\n${skill.metadata.description} Use MCP tool \`yaao_skill_${skill.metadata.name}\` with ${inputs}.`;
}
