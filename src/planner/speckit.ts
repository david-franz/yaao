import type { ParsedPlan, ParsedTask } from './markdown.js';

/**
 * Spec Kit triplet: `spec.md` + `plan.md` + `tasks.md`. We translate to and from our
 * ParsedPlan IR so the rest of the pipeline (the converter, the validator) doesn't
 * have to care which format the user authored in.
 */

export interface SpecKitTriplet {
  spec: string;
  plan: string;
  tasks: string;
}

export function serializeSpecKit(plan: ParsedPlan): SpecKitTriplet {
  const spec = `# ${plan.title} — Spec\n\n${plan.description || '(no description)'}\n`;
  const planMd = `# ${plan.title} — Plan\n\n${plan.description || '(no description)'}\n`;
  const tasks = `# ${plan.title} — Tasks\n\n${plan.tasks
    .map((t) => renderTaskBlock(t))
    .join('\n\n')}\n`;
  return { spec, plan: planMd, tasks };
}

function renderTaskBlock(t: ParsedTask): string {
  const lines: string[] = [];
  lines.push(`- [ ] **${t.id}** — ${t.title}`);
  if (t.depends.length > 0) lines.push(`  - depends: ${t.depends.join(', ')}`);
  if (t.agent) lines.push(`  - agent: ${t.agent}`);
  if (t.model) lines.push(`  - model: ${t.model}`);
  if (t.files.length > 0) lines.push(`  - files: ${t.files.join(', ')}`);
  if (t.validation) lines.push(`  - validation: \`${t.validation}\``);
  if (t.prompt) {
    lines.push('');
    for (const line of t.prompt.split(/\r?\n/)) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

const TASK_LINE_RE = /^-\s*\[[xX ]\]\s*\*\*([a-z][a-z0-9-_]*)\*\*\s*[—-]\s*(.+)$/;

export function parseSpecKit(triplet: { spec?: string; plan?: string; tasks: string; title?: string }): ParsedPlan {
  const out: ParsedPlan = {
    title: '',
    description: '',
    metadata: { scope: 'feature' },
    tasks: [],
    issues: [],
  };
  out.title = triplet.title ?? extractTitle(triplet.spec ?? triplet.plan ?? triplet.tasks);
  out.description = extractDescription(triplet.spec ?? triplet.plan ?? '');

  const lines = triplet.tasks.split(/\r?\n/);
  let current: ParsedTask | undefined;
  let promptBuf: string[] = [];
  const flush = () => {
    if (!current) return;
    current.prompt = promptBuf.join('\n').trim();
    out.tasks.push(current);
    current = undefined;
    promptBuf = [];
  };
  for (const line of lines) {
    const m = line.match(TASK_LINE_RE);
    if (m) {
      flush();
      current = {
        id: m[1] as string,
        title: (m[2] ?? '').trim(),
        depends: [],
        prompt: '',
        files: [],
      };
      continue;
    }
    if (!current) continue;
    const subM = line.match(/^\s*-\s+([a-z][a-z0-9-_]*):\s*(.*)$/i);
    if (subM && subM[1]) {
      const key = subM[1];
      const value = (subM[2] ?? '').trim();
      if (key === 'depends') current.depends = value.split(',').map((s) => s.trim()).filter(Boolean);
      else if (key === 'agent') current.agent = value;
      else if (key === 'model') current.model = value;
      else if (key === 'files') current.files = value.split(',').map((s) => s.trim()).filter(Boolean);
      else if (key === 'validation') current.validation = value.replace(/^`|`$/g, '');
      continue;
    }
    promptBuf.push(line.replace(/^\s{0,2}/, ''));
  }
  flush();
  return out;
}

function extractTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# ')) {
      return line.slice(2).replace(/ — (Spec|Plan|Tasks)$/i, '').trim();
    }
  }
  return '';
}

function extractDescription(text: string): string {
  const lines = text.split(/\r?\n/);
  let pastTitle = false;
  for (const line of lines) {
    if (!pastTitle) {
      if (line.startsWith('# ')) pastTitle = true;
      continue;
    }
    if (line.trim() === '') continue;
    if (line.startsWith('#')) break;
    return line.trim();
  }
  return '';
}
