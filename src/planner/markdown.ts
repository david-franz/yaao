/**
 * Parse + serialize for the F9.2 markdown plan format. Operates on the IR shape used
 * by the F10 converter, so a Markdown plan can round-trip through structure.
 */

export interface ParsedTask {
  id: string;
  title: string;
  depends: string[];
  agent?: string;
  model?: string;
  prompt: string;
  files: string[];
  validation?: string;
}

export interface ParsedPlan {
  title: string;
  description: string;
  metadata: Record<string, string>;
  tasks: ParsedTask[];
  /** Issues discovered during parse (heading/table mismatches, etc). */
  issues: { code: string; message: string }[];
  /**
   * F14.5 — Verbatim contents of the source spec.md and plan.md files
   * (when present), preserved for propagation into the generated
   * execution plan's `plan.context` field. The markdown parser leaves
   * these unset; the Spec Kit parser populates them when given a
   * triplet. Consumers should treat undefined as "no propagation".
   */
  specContent?: string;
  planContent?: string;
}

const SLUG_RE = /^[a-z][a-z0-9-_]*$/;

export function parseMarkdownPlan(source: string): ParsedPlan {
  const lines = source.split(/\r?\n/);
  const plan: ParsedPlan = {
    title: '',
    description: '',
    metadata: {},
    tasks: [],
    issues: [],
  };

  // 1) Title — first H1
  const h1Idx = lines.findIndex((l) => l.startsWith('# '));
  if (h1Idx >= 0) plan.title = lines[h1Idx]?.slice(2).trim() ?? '';

  // 2) Description — first blockquote paragraph after the title
  for (let i = h1Idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.startsWith('>')) {
      plan.description = line.replace(/^>\s?/, '').trim();
      break;
    }
    if (line.startsWith('# ') || line.startsWith('## ')) break;
  }

  // 3) Metadata — bullets under `## Metadata`
  const metaIdx = lines.findIndex((l) => /^##\s+Metadata\b/i.test(l));
  if (metaIdx >= 0) {
    for (let i = metaIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      if (/^##\s+/.test(line)) break;
      const m = line.match(/^-\s+([a-z][a-z0-9-_]*):\s*(.*)$/i);
      if (m && m[1] !== undefined) plan.metadata[m[1]] = (m[2] ?? '').trim();
    }
  }

  // 4) Tasks table — under `## Tasks`
  const tasksHeadIdx = lines.findIndex((l) => /^##\s+Tasks\b/i.test(l));
  const tableTasks = tasksHeadIdx >= 0 ? parseTaskTable(lines, tasksHeadIdx, plan.issues) : [];

  // 5) Per-task sections: `## <id> — <title>` (em-dash or hyphen)
  const sectionTasks = parseTaskSections(lines, plan.issues);

  // 6) Cross-check table vs sections
  const tableIds = new Set(tableTasks.map((t) => t.id));
  const sectionIds = new Set(sectionTasks.map((t) => t.id));
  for (const id of tableIds) {
    if (!sectionIds.has(id)) {
      plan.issues.push({
        code: 'YAAO_PLAN_TASK_MISSING_HEADING',
        message: `task '${id}' is in the Tasks table but has no '## ${id} — ...' heading`,
      });
    }
  }
  for (const id of sectionIds) {
    if (!tableIds.has(id)) {
      plan.issues.push({
        code: 'YAAO_PLAN_TASK_MISSING_TABLE_ROW',
        message: `task '${id}' has a heading but is missing from the Tasks table`,
      });
    }
  }

  // 7) Merge: table fields authoritative; section provides prose/files/validation.
  const byId = new Map<string, ParsedTask>();
  for (const t of tableTasks) byId.set(t.id, { ...t });
  for (const s of sectionTasks) {
    const t = byId.get(s.id);
    if (!t) {
      // Section without table row — still include it, with what we have.
      byId.set(s.id, s);
      continue;
    }
    t.prompt = s.prompt;
    t.files = s.files;
    if (s.validation) t.validation = s.validation;
  }
  plan.tasks = [...byId.values()];
  return plan;
}

function parseTaskTable(
  lines: string[],
  startIdx: number,
  issues: { code: string; message: string }[],
): ParsedTask[] {
  const out: ParsedTask[] = [];
  let i = startIdx + 1;
  // Skip blank lines until we hit the header
  while (i < lines.length && lines[i]?.trim() === '') i += 1;
  const header = lines[i];
  if (!header || !header.startsWith('|')) return out;
  // Build a column index from the header
  const cols = splitTableRow(header);
  const idx = {
    id: cols.findIndex((c) => c === 'id'),
    title: cols.findIndex((c) => c === 'title'),
    depends: cols.findIndex((c) => c === 'depends'),
    agent: cols.findIndex((c) => c.startsWith('agent')),
    model: cols.findIndex((c) => c.startsWith('model')),
  };
  if (idx.id < 0 || idx.title < 0 || idx.depends < 0) {
    issues.push({ code: 'YAAO_PLAN_TASK_TABLE_BAD_HEADER', message: 'Tasks table is missing required columns (id/title/depends)' });
    return out;
  }
  i += 1;
  // Skip the divider row
  if (i < lines.length && /^\|[\s:|-]+\|$/.test(lines[i] ?? '')) i += 1;
  for (; i < lines.length; i++) {
    const row = lines[i];
    if (row === undefined || !row.startsWith('|')) break;
    const cells = splitTableRow(row);
    const id = cells[idx.id];
    const title = cells[idx.title];
    if (!id || !title) continue;
    if (!SLUG_RE.test(id)) {
      issues.push({ code: 'YAAO_PLAN_TASK_ID_INVALID', message: `task id '${id}' is not a slug` });
      continue;
    }
    const depends = (cells[idx.depends] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const agent = idx.agent >= 0 ? cells[idx.agent]?.trim() || undefined : undefined;
    const model = idx.model >= 0 ? cells[idx.model]?.trim() || undefined : undefined;
    const t: ParsedTask = {
      id,
      title: title.trim(),
      depends,
      prompt: '',
      files: [],
    };
    if (agent) t.agent = agent;
    if (model) t.model = model;
    out.push(t);
  }
  return out;
}

function splitTableRow(row: string): string[] {
  // Trim the leading/trailing pipes, then split on pipes.
  return row
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

function parseTaskSections(
  lines: string[],
  _issues: { code: string; message: string }[],
): ParsedTask[] {
  // Headings look like `## <id> — <title>` (em-dash) or `## <id> - <title>` (hyphen).
  const re = /^##\s+([a-z][a-z0-9-_]*)\s+[—-]\s+(.+)$/;
  const out: ParsedTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const m = line.match(re);
    if (!m) continue;
    const id = m[1] as string;
    const title = (m[2] ?? '').trim();
    // Collect lines until the next `## ` heading (or EOF).
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (next === undefined) break;
      if (/^##\s+/.test(next)) break;
      body.push(next);
      j += 1;
    }
    const { prompt, files, validation } = splitTaskBody(body);
    const t: ParsedTask = { id, title, depends: [], prompt, files };
    if (validation !== undefined) t.validation = validation;
    out.push(t);
  }
  return out;
}

function splitTaskBody(body: string[]): { prompt: string; files: string[]; validation?: string } {
  let mode: 'prose' | 'files' | 'validation' = 'prose';
  const promptLines: string[] = [];
  const files: string[] = [];
  let validation: string | undefined;
  for (const line of body) {
    if (/^###\s+Files\b/i.test(line)) {
      mode = 'files';
      continue;
    }
    if (/^###\s+Validation\b/i.test(line)) {
      mode = 'validation';
      continue;
    }
    if (mode === 'files') {
      const m = line.match(/^-\s+(.+)$/);
      if (m && m[1]) files.push(m[1].replace(/\s*\(.*\)\s*$/, '').trim());
    } else if (mode === 'validation') {
      const m = line.match(/^-\s+`([^`]+)`\s*$/) ?? line.match(/^-\s+(.+)$/);
      if (m && m[1] && !validation) validation = m[1].trim();
    } else {
      promptLines.push(line);
    }
  }
  return { prompt: promptLines.join('\n').trim(), files, validation };
}

/** Serialize a `ParsedPlan` back to the canonical markdown shape. */
export function serializeMarkdownPlan(plan: ParsedPlan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push('');
  if (plan.description) {
    lines.push(`> ${plan.description}`);
    lines.push('');
  }
  if (Object.keys(plan.metadata).length > 0) {
    lines.push('## Metadata');
    lines.push('');
    for (const [k, v] of Object.entries(plan.metadata)) lines.push(`- ${k}: ${v}`);
    lines.push('');
  }

  // Tasks table
  lines.push('## Tasks');
  lines.push('');
  lines.push('| id | title | depends | agent (suggested) | model (suggested) |');
  lines.push('|----|-------|---------|-------------------|-------------------|');
  for (const t of plan.tasks) {
    lines.push(`| ${t.id} | ${t.title} | ${t.depends.join(', ')} | ${t.agent ?? ''} | ${t.model ?? ''} |`);
  }
  lines.push('');

  // Per-task sections
  for (const t of plan.tasks) {
    lines.push(`## ${t.id} — ${t.title}`);
    lines.push('');
    if (t.prompt) {
      lines.push(t.prompt);
      lines.push('');
    }
    if (t.files.length > 0) {
      lines.push('### Files');
      for (const f of t.files) lines.push(`- ${f}`);
      lines.push('');
    }
    if (t.validation) {
      lines.push('### Validation');
      lines.push(`- \`${t.validation}\``);
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}
