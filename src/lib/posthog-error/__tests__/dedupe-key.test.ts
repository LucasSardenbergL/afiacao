import { describe, it, expect } from 'vitest';
import { buildDedupeKey, buildRollupKey } from '../dedupe-key';

describe('buildDedupeKey', () => {
  it('compõe project:issue:action', () => {
    expect(buildDedupeKey({ projectId: 'p1', issueId: 'i9', action: 'created' })).toBe('p1:i9:created');
  });
  it('nulos/ausentes viram _ (sem quebrar a chave)', () => {
    expect(buildDedupeKey({})).toBe('_:_:_');
    expect(buildDedupeKey({ issueId: 'i9' })).toBe('_:i9:_');
  });
  it('trim nos componentes', () => {
    expect(buildDedupeKey({ projectId: ' p ', issueId: 'i', action: 'reopened' })).toBe('p:i:reopened');
  });
});

describe('buildRollupKey', () => {
  it('mesma janela de 30min → mesma chave', () => {
    const a = buildRollupKey('2026-06-04T10:05:00.000Z');
    const b = buildRollupKey('2026-06-04T10:29:59.000Z');
    expect(a).toBe(b);
  });
  it('janelas diferentes → chaves diferentes', () => {
    const a = buildRollupKey('2026-06-04T10:05:00.000Z');
    const b = buildRollupKey('2026-06-04T10:35:00.000Z');
    expect(a).not.toBe(b);
  });
  it('prefixo rollup:', () => {
    expect(buildRollupKey('2026-06-04T10:05:00.000Z')).toMatch(/^rollup:\d+$/);
  });
});
