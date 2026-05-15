export type PlanScope = 'feature' | 'project';

const PROJECT_KEYWORDS = [
  'project',
  'platform',
  'system',
  'rewrite',
  'rebuild',
  'overhaul',
  'migrate',
  'replatform',
  'across',
  'multi-phase',
  'multiple services',
  'monorepo',
  'green-field',
  'greenfield',
];

const FEATURE_KEYWORDS = ['add', 'fix', 'wire', 'rename', 'tweak', 'small', 'patch', 'bump'];

export interface ScopeSuggestion {
  scope: PlanScope;
  reason: string;
}

/**
 * Heuristic scope detection. Words alone aren't conclusive, but they're a useful
 * starting point — the user always overrides with `--scope` when needed.
 */
export function suggestScope(description: string): ScopeSuggestion {
  const text = description.trim();
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);

  // Hard project signals
  for (const kw of PROJECT_KEYWORDS) {
    if (lower.includes(kw)) {
      return { scope: 'project', reason: `description contains "${kw}"` };
    }
  }
  // Long descriptions tend to be projects
  if (words.length > 40) {
    return { scope: 'project', reason: `description is ${words.length} words long` };
  }
  // Feature signals
  for (const kw of FEATURE_KEYWORDS) {
    if (lower.startsWith(`${kw} `)) {
      return { scope: 'feature', reason: `description starts with "${kw}"` };
    }
  }
  return { scope: 'feature', reason: 'default for short, focused descriptions' };
}
