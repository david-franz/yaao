import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * F15.5 — Every `[label](path)` markdown link in the README and the
 * docs tree must resolve to an existing file (with optional anchor
 * fragment). Catches:
 *   - typos in a path after a F-doc rename
 *   - links to a moved feature doc
 *   - links to a removed example
 *   - links to a file that was deleted in a refactor
 *
 * External URLs (http://, https://, mailto:) and anchor-only links
 * (#section) are skipped — we only check on-disk paths.
 *
 * The test walks every .md file under the repo (excluding node_modules,
 * .git, dist, web/dist, web/node_modules) and asserts the link target
 * exists. A single broken link is one failed test; many broken links
 * surface as many failed tests, each named so the offending file and
 * link text are obvious.
 */

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    '.yaao',
    '.claude',
    '.cursor',
  ]);
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const abs = join(dir, entry);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(abs);
      } else if (s.isFile() && entry.endsWith('.md')) {
        out.push(abs);
      }
    }
  }
  walk(root);
  return out;
}

interface MdLink {
  text: string;
  target: string;
}

function stripFencedBlocks(body: string): string {
  // Remove fenced code blocks and inline `code` spans before link
  // extraction. Docs routinely embed literal markdown examples
  // ([label](path) syntax in prose) — those are demonstrations, not
  // real links, and we don't want the test to fail on them. Anyone
  // referencing a real file should write the link outside any code
  // span.
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]+`/g, '');
}

function extractLinks(body: string): MdLink[] {
  // `[label](target)` — non-greedy, handles parens-in-text and
  // multi-line label bodies. Backtick-wrapped code-snippet "links"
  // (e.g. `` [foo](bar) `` inside code spans) are out of scope for the
  // basic regex; we tolerate the occasional false positive by skipping
  // links whose target starts with backtick or contains a space.
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  const out: MdLink[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripFencedBlocks(body)))) {
    out.push({ text: m[1] ?? '', target: m[2] ?? '' });
  }
  return out;
}

function isExternal(target: string): boolean {
  return /^(https?:|mailto:|tel:|ftp:)/i.test(target);
}

function isAnchorOnly(target: string): boolean {
  return target.startsWith('#');
}

function stripFragment(target: string): string {
  const i = target.indexOf('#');
  return i < 0 ? target : target.slice(0, i);
}

const files = walkMarkdown(REPO_ROOT);

describe('F15.5 — every markdown link in repo .md files resolves', () => {
  it('walks at least the README and IMPLEMENTATION.md', () => {
    expect(files.some((f) => f.endsWith('README.md'))).toBe(true);
    expect(files.some((f) => f.endsWith('IMPLEMENTATION.md'))).toBe(true);
  });

  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    const links = extractLinks(body);
    const baseDir = dirname(file);
    const rel = file.slice(REPO_ROOT.length + 1);
    for (const link of links) {
      const target = stripFragment(link.target.trim());
      if (!target || isExternal(link.target) || isAnchorOnly(link.target)) continue;
      if (target.includes(' ')) continue;
      // Skip placeholder URLs in code blocks (a heuristic: target looks
      // like a vendor-namespaced shorthand without a real path).
      if (target.startsWith('<') && target.endsWith('>')) continue;
      it(`${rel}: link [${link.text.slice(0, 60)}](${target}) resolves`, () => {
        const abs = resolve(baseDir, target);
        expect(existsSync(abs)).toBe(true);
      });
    }
  }
});
