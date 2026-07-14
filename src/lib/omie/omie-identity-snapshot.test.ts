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

// ── PR-2/A2: client_to_user (prova positiva codigo_cliente→user, mesma RPC/snapshot) ──
// A validação de client_to_user é a ÚLTIMA (depois de doc_to_user/ambiguous_docs) → os casos de falha
// do PR-1 que passam objetos SEM client_to_user seguem lançando pelo motivo original, não por este.
describe('parseIdentitySnapshot — client_to_user (PR-2/A2, prova positiva codigo→user)', () => {
  it('client_to_user válido → clientToUserMap (codigo→user)', () => {
    const { clientToUserMap } = parseIdentitySnapshot({
      doc_to_user: { '11111111111': U1 },
      ambiguous_docs: [],
      client_to_user: { '1001': U1 },
    });
    expect(clientToUserMap.get('1001')).toBe(U1);
    expect(clientToUserMap.size).toBe(1);
  });

  it('client_to_user vazio → clientToUserMap vazio, NÃO lança', () => {
    const { clientToUserMap } = parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: {} });
    expect(clientToUserMap.size).toBe(0);
  });

  it('client_to_user null → LANÇA (RPC revertida em HTTP 200 não degrada p/ Map vazio silencioso)', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: null })).toThrow(/client_to_user/);
  });

  it('client_to_user não-objeto (array) → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: [] })).toThrow(/client_to_user/);
  });

  it('valor não-UUID em client_to_user → LANÇA (pegaria atribuição corrompida a jusante)', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: { '1001': 'nope' } })).toThrow(/não-UUID em client_to_user/);
  });

  // ── P3 hardening (Codex xhigh 2026-07-12): chave não-canônica viraria ALIAS por Number() a jusante ──
  it('chave "1e3" (notação científica) em client_to_user → LANÇA (Number("1e3")===1000 aliasaria o cliente 1000)', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: { '1e3': U1 } })).toThrow(/não-canônica/);
  });

  it('chave "01000" (zero à esquerda) → LANÇA (bigint::text nunca produz; fail-closed)', () => {
    expect(() => parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: { '01000': U1 } })).toThrow(/não-canônica/);
  });

  it('chave canônica "1001" segue aceita (não é falso-positivo do guard)', () => {
    const { clientToUserMap } = parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: { '1001': U1 } });
    expect(clientToUserMap.get('1001')).toBe(U1);
  });

  it('snapshot completo → os 3 mapas coerentes', () => {
    const { docToUserMap, ambiguousDocs, clientToUserMap } = parseIdentitySnapshot({
      doc_to_user: { '11111111111': U1 },
      ambiguous_docs: ['22222222222'],
      client_to_user: { '1001': U1 },
    });
    expect(docToUserMap.get('11111111111')).toBe(U1);
    expect(ambiguousDocs.has('22222222222')).toBe(true);
    expect(clientToUserMap.get('1001')).toBe(U1);
  });
});
