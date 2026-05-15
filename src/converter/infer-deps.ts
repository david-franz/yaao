import type { ParsedTask } from '../planner/markdown.js';

export type InferMode = 'off' | 'suggest' | 'auto';

export interface InferredDep {
  from: string; // task that depends on
  on: string;   // dependency target
  confidence: number;
  reason: string;
}

export interface InferOptions {
  threshold?: number;
  mode?: InferMode;
}

const LEXICAL_CUES = [
  /\b(uses|requires|depends on|needs|relies on|consumes|reads from|after)\b/i,
  /\b(extends|builds on|extended from)\b/i,
];

const TEST_CUES = [/\b(tests?|spec|e2e|integration)\b/i];
const UI_CUES = [/\b(ui|frontend|page|component)\b/i];
const API_CUES = [/\b(api|endpoint|route|server)\b/i];

/**
 * Estimate the probability that `tA` is a prerequisite for `tB`. Returns 0 when there
 * is no plausible relationship. Heuristics:
 *   - lexical: phrases in tB's prose ("uses X", "after X", "depends on")
 *   - reference: tA's file list appearing in tB's prose
 *   - domain: tests depend on the things they test; UIs depend on APIs
 */
export function scoreDep(tA: ParsedTask, tB: ParsedTask): { confidence: number; reasons: string[] } {
  if (tA.id === tB.id) return { confidence: 0, reasons: [] };
  if (tB.depends.includes(tA.id)) return { confidence: 0, reasons: ['already declared'] };

  const reasons: string[] = [];
  let score = 0;
  const promptLower = tB.prompt.toLowerCase();

  // Lexical: prose names the other task or its title
  if (promptLower.includes(tA.id.toLowerCase())) {
    score += 0.4;
    reasons.push(`mentions "${tA.id}"`);
  } else if (tA.title && promptLower.includes(tA.title.toLowerCase())) {
    score += 0.35;
    reasons.push(`mentions "${tA.title}"`);
  }

  // Lexical: dependency cues that suggest "after something"
  for (const cue of LEXICAL_CUES) {
    if (cue.test(promptLower) && (promptLower.includes(tA.id.toLowerCase()) || promptLower.includes(tA.title.toLowerCase()))) {
      score += 0.2;
      reasons.push('uses a dependency cue near a reference to the predecessor');
      break;
    }
  }

  // Reference matching: tB's prose references a file tA created
  for (const file of tA.files) {
    const base = file.split('/').pop() ?? file;
    if (base && tB.prompt.includes(base)) {
      score += 0.3;
      reasons.push(`references file "${base}" produced by "${tA.id}"`);
      break;
    }
  }

  // Domain heuristics: tests depend on non-test code; UI depends on API
  const aIsTest = TEST_CUES.some((re) => re.test(tA.title) || re.test(tA.id));
  const bIsTest = TEST_CUES.some((re) => re.test(tB.title) || re.test(tB.id));
  if (bIsTest && !aIsTest) {
    score += 0.1;
    reasons.push('tests depend on the things they test');
  }
  const aIsApi = API_CUES.some((re) => re.test(tA.title) || re.test(tA.id));
  const bIsUi = UI_CUES.some((re) => re.test(tB.title) || re.test(tB.id));
  if (bIsUi && aIsApi) {
    score += 0.1;
    reasons.push('UIs typically depend on APIs');
  }

  return { confidence: Math.min(1, score), reasons };
}

/**
 * Run pairwise inference across `tasks`, returning only suggestions above `threshold`
 * that don't create a cycle.
 */
export function inferDependencies(
  tasks: ParsedTask[],
  opts: InferOptions = {},
): InferredDep[] {
  if (opts.mode === 'off') return [];
  const threshold = opts.threshold ?? 0.7;
  const inferred: InferredDep[] = [];

  // Build the existing dep graph for cycle detection.
  const dependsOf = new Map<string, Set<string>>();
  for (const t of tasks) dependsOf.set(t.id, new Set(t.depends));

  const wouldCycle = (from: string, on: string): boolean => {
    if (from === on) return true;
    const visited = new Set<string>();
    const stack = [on];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined) continue;
      if (cur === from) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const deps = dependsOf.get(cur);
      if (deps) for (const d of deps) stack.push(d);
    }
    return false;
  };

  for (const tB of tasks) {
    for (const tA of tasks) {
      const s = scoreDep(tA, tB);
      if (s.confidence < threshold) continue;
      if (wouldCycle(tB.id, tA.id)) continue;
      inferred.push({
        from: tB.id,
        on: tA.id,
        confidence: Number(s.confidence.toFixed(2)),
        reason: s.reasons.join('; '),
      });
      // Update the graph so subsequent inferences see the new edge for cycle checks.
      dependsOf.get(tB.id)?.add(tA.id);
    }
  }
  return inferred;
}
