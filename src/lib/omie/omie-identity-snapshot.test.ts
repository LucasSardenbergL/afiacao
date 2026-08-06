import { describe, it, expect } from 'vitest';
import { parseIdentitySnapshot } from './omie-identity-snapshot';

const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';

describe('parseIdentitySnapshot (fail-closed do contrato da RPC omie_sync_identity_snapshot — Codex challenge PR-1)', () => {
  it('resposta válida → docToUserMap + ambiguousDocs', () => {
    const { docToUserMap, ambiguousDocs } = parseIdentitySnapshot({
      doc_to_user: { '11111111111': U1 },
      ambiguous_docs: ['22222222222'],
      client_to_user: {},
    });
    expect(docToUserMap.get('11111111111')).toBe(U1);
    expect(ambiguousDocs.has('22222222222')).toBe(true);
    expect(docToUserMap.size).toBe(1);
  });

  it('vazio (RPC sem docs) → mapas vazios, NÃO lança', () => {
    const { docToUserMap, ambiguousDocs } = parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: {} });
    expect(docToUserMap.size).toBe(0);
    expect(ambiguousDocs.size).toBe(0);
  });

  // ── FAIL-CLOSED: o cenário central do Codex (RPC revertida devolve nulls em HTTP 200) ──
  it('doc_to_user null → LANÇA (não degrada p/ Map vazio silencioso)', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: null, ambiguous_docs: null, client_to_user: null })).toThrow(/doc_to_user/);
  });
  it('snap null → LANÇA', () => {
    expect(() => parseIdentitySnapshot(null)).toThrow(/não é objeto/);
  });
  it('snap array → LANÇA', () => {
    expect(() => parseIdentitySnapshot([])).toThrow(/não é objeto/);
  });
  it('ambiguous_docs não-array → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: {} })).toThrow(/ambiguous_docs/);
  });
  it('valor não-UUID em doc_to_user → LANÇA (pegaria 22P02 ou corrupção silenciosa a jusante)', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: { '11111111111': 'não-uuid' }, ambiguous_docs: [] })).toThrow(/não-UUID/);
  });
  it('doc presente em doc_to_user E ambiguous_docs → LANÇA (fail-open da RPC)', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: { '33333333333': U2 }, ambiguous_docs: ['33333333333'] })).toThrow(/fail-open/);
  });
  it('item não-string em ambiguous_docs → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [123] })).toThrow(/não-string/);
  });
});
