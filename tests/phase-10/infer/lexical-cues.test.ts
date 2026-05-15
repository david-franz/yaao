import { describe, it, expect } from 'vitest';
import { inferDependencies, scoreDep } from '../../../src/converter/infer-deps.js';
import type { ParsedTask } from '../../../src/planner/markdown.js';

function t(id: string, title: string, prompt: string, files: string[] = [], depends: string[] = []): ParsedTask {
  return { id, title, prompt, files, depends };
}

describe('inferDependencies: lexical cues', () => {
  it('lexical cue + name reference produces an inference at the default threshold', () => {
    const tasks = [
      // tB's prose mentions tA's file by basename to push past the default 0.7.
      t('scaffold', 'Scaffold', 'Set up the directory.', ['src/auth/oauth.ts']),
      t(
        'api',
        'API',
        'Implement the API. This task uses the scaffold module (oauth.ts) to register routes.',
      ),
    ];
    const inferred = inferDependencies(tasks);
    expect(inferred.find((i) => i.from === 'api' && i.on === 'scaffold')).toBeDefined();
  });

  it('off mode returns no inferences', () => {
    const tasks = [
      t('scaffold', 'Scaffold', 'Set up the directory.'),
      t('api', 'API', 'Implement the API. Uses scaffold module.'),
    ];
    expect(inferDependencies(tasks, { mode: 'off' })).toEqual([]);
  });

  it('avoids creating a cycle when inferring', () => {
    const tasks = [
      t('a', 'A', 'A depends on b somehow. Uses b extensively.', [], ['b']),
      t('b', 'B', 'B depends on a obviously. Uses a as a base.', [], ['a']),
    ];
    // Both tasks reference each other so scoreDep would propose a -> b and b -> a;
    // the cycle check should drop at least one.
    const inferred = inferDependencies(tasks, { threshold: 0.3 });
    const pairs = inferred.map((i) => `${i.from}->${i.on}`).sort();
    // We don't make claims about which direction wins, only that not both edges land.
    expect(pairs.length).toBeLessThan(2);
  });

  it('scoreDep ignores already-declared dependencies', () => {
    const tasks = [
      t('a', 'A', 'A'),
      t('b', 'B', 'B uses a.', [], ['a']),
    ];
    const s = scoreDep(tasks[0] as ParsedTask, tasks[1] as ParsedTask);
    expect(s.confidence).toBe(0);
  });
});
