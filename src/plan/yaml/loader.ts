import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { LineCounter, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import type { YaaoConfig } from '../../config/types.js';
import {
  IncludeCycleError,
  IncludeDepthError,
  PlanNotFoundError,
  PlanParseError,
  PlanValidationError,
} from '../../log/errors.js';
import { PlanSchema, type Plan } from '../schema/plan.js';
import { resolvePlan, type ResolvedPlan } from '../schema/resolve.js';

export interface LoadOptions {
  cwd: string;
  config: YaaoConfig;
  maxIncludeDepth?: number;
}

export interface SourcePosition {
  file: string;
  line: number;
  col: number;
}

export type SourceMap = Map<string, SourcePosition>;

export interface LoadedFile {
  path: string;
  raw: string;
}

export interface LoadResult {
  plan: ResolvedPlan;
  files: LoadedFile[];
  source: SourceMap;
}

interface RawLoaded {
  path: string;
  raw: Plan;
  source: SourceMap;
}

const DEFAULT_MAX_DEPTH = 8;

export async function loadPlan(planPath: string, opts: LoadOptions): Promise<LoadResult> {
  const startAbs = resolve(opts.cwd, planPath);
  const visited = new Map<string, RawLoaded | 'pending'>();
  const stack: string[] = [];
  const files: LoadedFile[] = [];
  const root = await loadOne(startAbs, visited, stack, files, 0, opts.maxIncludeDepth ?? DEFAULT_MAX_DEPTH);

  // Merge: top-level wins for config/context. Tasks concatenated in include order.
  const rootIncludes = root.raw.includes ?? [];
  const rootTasks = root.raw.tasks ?? [];
  const merged: Plan = {
    plan: root.raw.plan,
    config: root.raw.config,
    context: root.raw.context,
    includes: rootIncludes,
    tasks: [...rootTasks],
  };
  const source: SourceMap = new Map(root.source);

  for (const inc of rootIncludes) {
    const incAbs = resolve(dirname(startAbs), inc);
    const child = visited.get(incAbs);
    if (child && child !== 'pending') {
      // Push child tasks (if not already covered by recursion) and merge source map.
      const childTasks = child.raw.tasks ?? [];
      for (const t of childTasks) {
        if (!merged.tasks.find((x) => x.id === t.id)) {
          merged.tasks.push(t);
        }
      }
      for (const [id, pos] of child.source.entries()) {
        if (!source.has(id)) source.set(id, pos);
      }
      // Fill config/context fields the root left unset.
      if (!merged.config && child.raw.config) merged.config = child.raw.config;
      if (!merged.context && child.raw.context) merged.context = child.raw.context;
    }
  }

  // Validate the merged plan via Zod and resolve defaults.
  const parsed = PlanSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path,
      message: i.message,
    }));
    const head = issues[0];
    throw new PlanValidationError({
      message: head ? `${head.path.join('.') || '<root>'}: ${head.message}` : 'invalid plan',
      issues,
      cause: parsed.error,
    });
  }

  const resolved = resolvePlan(parsed.data, { config: opts.config });
  return { plan: resolved, files, source };
}

async function loadOne(
  abs: string,
  visited: Map<string, RawLoaded | 'pending'>,
  stack: string[],
  files: LoadedFile[],
  depth: number,
  maxDepth: number,
): Promise<RawLoaded> {
  if (depth > maxDepth) {
    throw new IncludeDepthError({
      message: `include depth exceeds ${maxDepth} at ${abs}`,
      depth,
    });
  }
  if (stack.includes(abs)) {
    throw new IncludeCycleError({
      message: `include cycle detected: ${[...stack, abs].join(' -> ')}`,
      cycle: [...stack, abs],
    });
  }
  const cached = visited.get(abs);
  if (cached && cached !== 'pending') return cached;
  visited.set(abs, 'pending');

  if (!existsSync(abs)) {
    throw new PlanNotFoundError({ message: `plan file not found: ${abs}`, path: abs });
  }

  const raw = readFileSync(abs, 'utf8');
  files.push({ path: abs, raw });

  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    if (!e) {
      throw new PlanParseError({
        message: `failed to parse ${abs}`,
        file: abs,
      });
    }
    const pos = e.linePos?.[0];
    throw new PlanParseError({
      message: `${relative(process.cwd(), abs)}:${pos?.line ?? '?'}:${pos?.col ?? '?'}: ${e.message}`,
      file: abs,
      line: pos?.line,
      col: pos?.col,
    });
  }

  const data = doc.toJSON() as Plan;
  const source = buildSourceMap(abs, doc, lineCounter);

  // Recurse into includes (relative to this file's directory).
  const here: RawLoaded = { path: abs, raw: data, source };
  visited.set(abs, here);

  if (Array.isArray(data.includes)) {
    stack.push(abs);
    try {
      for (const inc of data.includes) {
        const incAbs = isAbsolute(inc) ? inc : resolve(dirname(abs), inc);
        // eslint-disable-next-line no-await-in-loop -- includes load sequentially to keep cycle detection deterministic
        await loadOne(incAbs, visited, stack, files, depth + 1, maxDepth);
      }
    } finally {
      stack.pop();
    }
  }

  return here;
}

function buildSourceMap(file: string, doc: Document, lineCounter: LineCounter): SourceMap {
  const map: SourceMap = new Map();
  const tasks = (doc.get('tasks', true) as YAMLSeq | undefined) ?? undefined;
  if (!tasks || !Array.isArray(tasks.items)) return map;
  for (const item of tasks.items) {
    const taskNode = item as YAMLMap;
    const idNode = taskNode.get('id', true) as { value?: unknown; range?: [number, number] } | undefined;
    const idVal = idNode && typeof idNode.value === 'string' ? idNode.value : undefined;
    if (!idVal) continue;
    const range = idNode?.range ?? (taskNode as unknown as { range?: [number, number] }).range;
    const offset = range?.[0];
    if (offset === undefined) continue;
    const lc = lineCounter.linePos(offset);
    map.set(idVal, { file, line: lc.line, col: lc.col });
  }
  return map;
}
