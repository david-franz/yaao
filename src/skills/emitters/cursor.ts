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

const MCP_FILE = join('.cursor', 'mcp.json');
const RULES_FILE = join('.cursor', 'rules', 'yaao.mdc');

const YAAO_SERVER = { command: 'yaao', args: ['serve', '--stdio'] };

export function emitCursor(skills: LoadedSkill[], opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const applicable = skills.filter((s) => s.metadata.appliesTo.agents.includes('cursor'));
  const out: EmitResult = { files: [] };

  if (applicable.length === 0) {
    return out;
  }

  // 1) Manage the `yaao` entry inside `.cursor/mcp.json`, preserving user entries.
  const mcpPath = join(cwd, MCP_FILE);
  mkdirSync(dirname(mcpPath), { recursive: true });
  const mcpExisting = existsSync(mcpPath) ? readFileSync(mcpPath, 'utf8') : '';
  const desiredMcp = mergeMcpJson(mcpExisting, YAAO_SERVER);
  if (desiredMcp !== mcpExisting) writeFileSync(mcpPath, desiredMcp);
  out.files.push({ path: MCP_FILE, changed: desiredMcp !== mcpExisting });

  // 2) Write `.cursor/rules/yaao.mdc` with one managed block per skill.
  const rulesPath = join(cwd, RULES_FILE);
  mkdirSync(dirname(rulesPath), { recursive: true });
  const header = `---\ndescription: yaao MCP tools available in this workspace\nalwaysApply: true\n---\n\n`;
  let body = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : header;
  if (!body.startsWith('---')) body = header + body;
  let changed = body.length !== readIfExists(rulesPath).length;
  for (const skill of applicable) {
    const block = upsertBlock(
      body,
      {
        name: skill.metadata.name,
        version: skill.metadata.version,
        body: renderCursorBlock(skill),
      },
      { ...(opts.force !== undefined ? { force: opts.force } : {}) },
    );
    body = block.text;
    changed = changed || block.changed;
  }
  if (changed) writeFileSync(rulesPath, body);
  out.files.push({ path: RULES_FILE, changed });
  return out;
}

export function removeCursorSkill(name: string, opts: EmitOptions): EmitResult {
  const cwd = resolve(opts.cwd);
  const out: EmitResult = { files: [] };
  const rulesPath = join(cwd, RULES_FILE);
  if (existsSync(rulesPath)) {
    const r = removeBlock(readFileSync(rulesPath, 'utf8'), name);
    if (r.removed) writeFileSync(rulesPath, r.text);
    out.files.push({ path: RULES_FILE, changed: r.removed });
  }
  return out;
}

export function mergeMcpJson(existing: string, yaaoServer: { command: string; args: string[] }): string {
  let parsed: { mcpServers?: Record<string, unknown> };
  if (existing.trim().length === 0) {
    parsed = { mcpServers: {} };
  } else {
    try {
      parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    } catch {
      parsed = { mcpServers: {} };
    }
  }
  parsed.mcpServers = parsed.mcpServers ?? {};
  parsed.mcpServers['yaao'] = yaaoServer;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function renderCursorBlock(skill: LoadedSkill): string {
  const inputs = skill.metadata.inputs.length === 0
    ? '`{}`'
    : `\`{ ${skill.metadata.inputs.map((i) => `${i.name}${i.required === false ? '?' : ''}`).join(', ')} }\``;
  return `## ${skill.metadata.name}\n\n${skill.metadata.description} Use MCP tool \`yaao_skill_${skill.metadata.name}\` with ${inputs}.`;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
