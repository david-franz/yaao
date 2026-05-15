/**
 * Helpers for inserting/updating/removing yaao-managed blocks in markdown files.
 *
 * A managed block is delimited by:
 *   <!-- yaao-managed: <name>@<version> -->
 *   ...body...
 *   <!-- /yaao-managed: <name>@<version> -->
 *
 * The name+version pair is the lookup key — re-emitting the same name with a different
 * version replaces the block in place, regardless of which version was previously there.
 */

const BEGIN = (name: string): string => `<!-- yaao-managed: ${name}`;
const END = (name: string): string => `<!-- /yaao-managed: ${name}`;

export interface BlockSpec {
  name: string;
  version: number;
  body: string; // body must not include the delimiters
}

export function renderBlock(spec: BlockSpec): string {
  return [
    `<!-- yaao-managed: ${spec.name}@${spec.version} -->`,
    spec.body.replace(/\n+$/, ''),
    `<!-- /yaao-managed: ${spec.name}@${spec.version} -->`,
  ].join('\n');
}

export interface UpsertOptions {
  /** When true, ignore the version check and force-replace. */
  force?: boolean;
}

export interface UpsertResult {
  text: string;
  changed: boolean;
  /** True if the file had a different version of the block before. */
  replaced: boolean;
}

/**
 * Insert or replace a managed block in `existing`. Blocks not matching `spec.name` are
 * left untouched. If a block with the same name (any version) exists, it's replaced.
 */
export function upsertBlock(existing: string, spec: BlockSpec, opts: UpsertOptions = {}): UpsertResult {
  const rendered = renderBlock(spec);
  const beginRe = new RegExp(`<!-- yaao-managed: ${escapeRe(spec.name)}@\\d+ -->`);
  const endRe = new RegExp(`<!-- /yaao-managed: ${escapeRe(spec.name)}@\\d+ -->`);
  const beginMatch = beginRe.exec(existing);
  if (!beginMatch) {
    // Append; ensure a blank line separator if file is non-empty.
    const sep = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return { text: `${existing}${sep}${rendered}\n`, changed: true, replaced: false };
  }
  const endMatch = endRe.exec(existing.slice(beginMatch.index));
  if (!endMatch) {
    if (!opts.force) {
      // Malformed: only BEGIN present. Refuse to mangle.
      return { text: existing, changed: false, replaced: false };
    }
    // Force: drop everything from BEGIN onward and append the new block.
    const truncated = existing.slice(0, beginMatch.index).replace(/\s*$/, '\n');
    return { text: `${truncated}\n${rendered}\n`, changed: true, replaced: true };
  }
  const endAbs = beginMatch.index + endMatch.index + endMatch[0].length;
  const before = existing.slice(0, beginMatch.index);
  const after = existing.slice(endAbs);
  const next = `${before}${rendered}${after}`;
  return { text: next, changed: next !== existing, replaced: true };
}

export function removeBlock(existing: string, name: string): { text: string; removed: boolean } {
  const beginRe = new RegExp(`<!-- yaao-managed: ${escapeRe(name)}@\\d+ -->`);
  const endRe = new RegExp(`<!-- /yaao-managed: ${escapeRe(name)}@\\d+ -->`);
  const beginMatch = beginRe.exec(existing);
  if (!beginMatch) return { text: existing, removed: false };
  const endMatch = endRe.exec(existing.slice(beginMatch.index));
  if (!endMatch) return { text: existing, removed: false };
  const endAbs = beginMatch.index + endMatch.index + endMatch[0].length;
  let cutBegin = beginMatch.index;
  let cutEnd = endAbs;
  // Tighten trailing newline so we don't leave two blank lines behind.
  if (existing[cutEnd] === '\n') cutEnd += 1;
  if (cutBegin > 0 && existing[cutBegin - 1] === '\n' && existing[cutBegin - 2] === '\n') {
    cutBegin -= 1;
  }
  return { text: `${existing.slice(0, cutBegin)}${existing.slice(cutEnd)}`, removed: true };
}

/** Return every yaao-managed block name found in `existing` (for prune/list flows). */
export function listManagedBlocks(existing: string): string[] {
  const out: string[] = [];
  const re = /<!-- yaao-managed: ([a-z0-9][a-z0-9-_]*)@\d+ -->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(existing))) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Re-export the prefixes so per-emitter code can reference them in tests.
export { BEGIN, END };
