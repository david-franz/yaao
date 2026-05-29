import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectOrphan, ORPHAN_STALE_MS } from '../../../src/doctor/orphan-detection.js';

function freshRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'yaao-orphan-'));
}

function writeJournal(runDir: string, ageSeconds: number): void {
  const path = join(runDir, 'journal.jsonl');
  writeFileSync(path, '{"t":"run:start"}\n');
  const mtime = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, mtime, mtime);
}

describe('F15.1 — orphan-run detection', () => {
  it('returns not-orphaned when status is not running', () => {
    const dir = freshRunDir();
    const r = detectOrphan({ runDir: dir, summary: { status: 'success' } });
    expect(r.orphaned).toBe(false);
  });

  it('returns orphaned when journal is missing entirely', () => {
    const dir = freshRunDir();
    const r = detectOrphan({ runDir: dir, summary: { status: 'running' } });
    expect(r.orphaned).toBe(true);
    expect(r.reason).toMatch(/journal.jsonl is missing/);
  });

  it('returns not-orphaned when journal was written within the stale window', () => {
    const dir = freshRunDir();
    writeJournal(dir, 5);
    const r = detectOrphan({ runDir: dir, summary: { status: 'running' } });
    expect(r.orphaned).toBe(false);
    expect(r.reason).toMatch(/recently written/);
  });

  it('returns orphaned when journal is stale AND no runner.pid file exists', () => {
    const dir = freshRunDir();
    writeJournal(dir, 120);
    const r = detectOrphan({ runDir: dir, summary: { status: 'running' } });
    expect(r.orphaned).toBe(true);
    expect(r.reason).toMatch(/no runner\.pid/);
  });

  it('returns orphaned when pid in runner.pid is no longer alive', () => {
    const dir = freshRunDir();
    writeJournal(dir, 120);
    writeFileSync(join(dir, 'runner.pid'), '99999\n');
    const r = detectOrphan({
      runDir: dir,
      summary: { status: 'running' },
      isPidAlive: () => false,
    });
    expect(r.orphaned).toBe(true);
    expect(r.reason).toMatch(/no longer alive/);
  });

  it('returns not-orphaned when runner.pid is alive (even with stale journal)', () => {
    const dir = freshRunDir();
    writeJournal(dir, 120);
    writeFileSync(join(dir, 'runner.pid'), '12345\n');
    const r = detectOrphan({
      runDir: dir,
      summary: { status: 'running' },
      isPidAlive: () => true,
    });
    expect(r.orphaned).toBe(false);
    expect(r.reason).toMatch(/still alive/);
  });

  it('returns orphaned when runner.pid is unreadable', () => {
    const dir = freshRunDir();
    writeJournal(dir, 120);
    writeFileSync(join(dir, 'runner.pid'), 'not a number\n');
    const r = detectOrphan({ runDir: dir, summary: { status: 'running' } });
    expect(r.orphaned).toBe(true);
    expect(r.reason).toMatch(/unreadable/);
  });

  it('uses the supplied staleMs override', () => {
    const dir = freshRunDir();
    writeJournal(dir, 5);
    const r = detectOrphan({
      runDir: dir,
      summary: { status: 'running' },
      staleMs: 1000,
    });
    expect(r.orphaned).toBe(true);
  });

  it('default ORPHAN_STALE_MS is 60s', () => {
    expect(ORPHAN_STALE_MS).toBe(60_000);
  });
});
