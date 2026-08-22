import { describe, it, expect } from 'vitest';
import { parseIdentitySnapshot, aplicarProvaPositivaNoCache } from './omie-identity-snapshot';

const U1 = '00000000-0000-0000-0000-000000000001';
const U2 = '00000000-0000-0000-0000-000000000002';
const U3 = '00000000-0000-0000-0000-000000000003';

describe('parseIdentitySnapshot (fail-closed do contrato da RPC omie_sync_identity_snapshot — Codex challenge PR-1)', () => {
  it('resposta válida → docToUserMap + ambiguousDocs', () => {
    const { docToUserMap, ambiguousDocs } = parseIdentitySnapshot({
      doc_to_user: { '11111111111': U1 },
      ambiguous_docs: ['22222222222'],
      client_to_user: {},
      revoked_client_codes: [],
    });
    expect(docToUserMap.get('11111111111')).toBe(U1);
    expect(ambiguousDocs.has('22222222222')).toBe(true);
    expect(docToUserMap.size).toBe(1);
  });

  it('vazio (RPC sem docs) → mapas vazios, NÃO lança', () => {
    const { docToUserMap, ambiguousDocs } = parseIdentitySnapshot({ doc_to_user: {}, ambiguous_docs: [], client_to_user: {}, revoked_client_codes: [] });
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

// ── PR-2/A2: client_to_user (prova positiva). O guard de FORMA é a única defesa do lado do edge: a RPC
// pode estar revertida (sem a chave), meio-aplicada, ou de uma versão futura cujo contrato este código
// não conhece. Em todos os casos, LANÇAR e abortar o run é preferível a mapear dono de pedido errado.
describe('parseIdentitySnapshot — client_to_user (PR-2/A2, prova positiva)', () => {
  const base = { doc_to_user: { '11111111111': U1, '22222222222': U2 }, ambiguous_docs: [], revoked_client_codes: [] };

  it('client_to_user válido → clientToUser com chave NUMÉRICA (o cache do edge é Map<number>)', () => {
    const { clientToUser } = parseIdentitySnapshot({ ...base, client_to_user: { '101': U1, '202': U2 } });
    expect(clientToUser.get(101)).toBe(U1);
    expect(clientToUser.get(202)).toBe(U2);
    expect(clientToUser.size).toBe(2);
    // regressão: chave STRING faria todo lookup do edge (que usa number) dar miss silencioso
    expect([...clientToUser.keys()].every((k) => typeof k === 'number')).toBe(true);
  });

  it('client_to_user vazio → Map vazio e NÃO lança (é o estado de hoje: evidence ainda NULL)', () => {
    const { clientToUser } = parseIdentitySnapshot({ ...base, client_to_user: {} });
    expect(clientToUser.size).toBe(0);
  });

  it('client_to_user AUSENTE → LANÇA (RPC anterior ao PR-1; `{}` silencioso seria idêntico a "sem prova")', () => {
    expect(() => parseIdentitySnapshot({ ...base })).toThrow(/client_to_user/);
  });
  it('client_to_user null → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ ...base, client_to_user: null })).toThrow(/client_to_user/);
  });
  it('client_to_user array → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ ...base, client_to_user: [] })).toThrow(/client_to_user/);
  });
  it('valor não-UUID em client_to_user → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ ...base, client_to_user: { '101': 'nao-uuid' } })).toThrow(/não-UUID/);
  });

  // A família `Number()` permissivo: cada uma destas viraria um código de cliente FABRICADO no cache.
  it.each([
    ['abc', 'texto'],
    ['0x65', 'hexadecimal — Number("0x65") === 101'],
    ['1e3', 'notação científica — Number("1e3") === 1000'],
    [' 101 ', 'com espaços — Number(" 101 ") === 101'],
    ['', 'vazio — Number("") === 0'],
    ['0101', 'zero à esquerda'],
    ['0', 'zero não é código de cliente'],
    ['-5', 'negativo'],
    ['10.5', 'decimal'],
    ['9007199254740992', 'acima de MAX_SAFE_INTEGER (perde precisão e casa outro cliente)'],
  ])('chave %s em client_to_user → LANÇA (%s)', (chave) => {
    expect(() => parseIdentitySnapshot({ ...base, client_to_user: { [chave]: U1 } })).toThrow(/código de cliente/);
  });

  it('user provado FORA de doc_to_user → LANÇA (v1 só admite source=document, que implica doc único)', () => {
    expect(() => parseIdentitySnapshot({ ...base, client_to_user: { '101': U3 } })).toThrow(/fora de doc_to_user/);
  });
});

// ── PR-2/A2: a sobreposição da prova sobre o cache. É AQUI que o achado é fechado (o dono do pedido é
// lido direto do cache), então o teste mede CONTROLE — o efeito no Map — e não a presença do texto.
describe('aplicarProvaPositivaNoCache (PR-2/A2)', () => {
  it('prova VAZIA → cache intacto e cobertura 0 (o estado inerte de hoje)', () => {
    const cache = new Map<number, string | null>([[101, U1], [202, U2]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map(), new Set());
    expect(cache.get(101)).toBe(U1);
    expect(cache.get(202)).toBe(U2);
    expect(cache.size).toBe(2);
    expect(r).toEqual({ cacheDaView: 2, provados: 0, divergencias: 0, revogados: 0, cobertura: 0 });
  });

  it('ACHADO A2: onde a prova DISCORDA do cache, o cache é CORRIGIDO e a divergência é contada', () => {
    // o cache da view diz que o código 101 é do U1 (vínculo criado com um doc que migrou de dono);
    // a prova, do mesmo snapshot de doc_to_user, diz que a evidência viva aponta para U2.
    const cache = new Map<number, string | null>([[101, U1]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map([[101, U2]]), new Set());
    expect(cache.get(101)).toBe(U2);
    expect(r.divergencias).toBe(1);
  });

  it('prova que CONCORDA não conta divergência', () => {
    const cache = new Map<number, string | null>([[101, U1]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map([[101, U1]]), new Set());
    expect(cache.get(101)).toBe(U1);
    expect(r.divergencias).toBe(0);
  });

  it('código provado que não está no cache entra sem contar divergência (ausência ≠ discordância)', () => {
    const cache = new Map<number, string | null>([[101, U1]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map([[303, U2]]), new Set());
    expect(cache.get(303)).toBe(U2);
    expect(r.divergencias).toBe(0);
    expect(r.cacheDaView).toBe(1); // o denominador é o cache ANTES da sobreposição
  });

  it('código SEM prova sobrevive no cache — degrada para o status quo, não apaga nem zera', () => {
    const cache = new Map<number, string | null>([[101, U1], [202, U2]]);
    aplicarProvaPositivaNoCache(cache, new Map([[101, U1]]), new Set());
    expect(cache.get(202)).toBe(U2);
    expect(cache.size).toBe(2);
  });

  it('null no cache conta como divergência quando a prova diz um user (não é "concorda com ausência")', () => {
    const cache = new Map<number, string | null>([[101, null]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map([[101, U1]]), new Set());
    expect(cache.get(101)).toBe(U1);
    expect(r.divergencias).toBe(1);
  });

  it('cobertura é % de provados sobre o cache da view; cache vazio → 0 e não NaN', () => {
    const cache = new Map<number, string | null>([[1, U1], [2, U1], [3, U1], [4, U1]]);
    expect(aplicarProvaPositivaNoCache(cache, new Map([[1, U1]]), new Set()).cobertura).toBe(25);
    // Math.round(1/0*100) seria NaN — número fabricado no lugar de "sem denominador"
    expect(aplicarProvaPositivaNoCache(new Map(), new Map(), new Set()).cobertura).toBe(0);
  });
});

// ── PR-2/A2 — REVOGAÇÃO. O achado do challenge Codex: a prova positiva sozinha só OMITE o vínculo podre,
// e omitir não corrige nada — o código continua no cache do leitor. Estes testes cobrem o contrato da
// 4ª chave e o efeito dela no cache, que é onde o dono do pedido é lido.
describe('parseIdentitySnapshot — revoked_client_codes (PR-2/A2)', () => {
  const base = { doc_to_user: { '11111111111': U1 }, ambiguous_docs: [], client_to_user: {} };

  it('revoked_client_codes válido → Set com chaves NUMÉRICAS', () => {
    const { revokedClientCodes } = parseIdentitySnapshot({ ...base, revoked_client_codes: ['105', '112'] });
    expect(revokedClientCodes.has(105)).toBe(true);
    expect(revokedClientCodes.has(112)).toBe(true);
    expect([...revokedClientCodes].every((k) => typeof k === 'number')).toBe(true);
  });

  it('revoked_client_codes AUSENTE → LANÇA (`[]` silencioso reabriria o fail-open)', () => {
    expect(() => parseIdentitySnapshot({ ...base })).toThrow(/revoked_client_codes/);
  });
  it('revoked_client_codes não-array → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ ...base, revoked_client_codes: {} })).toThrow(/revoked_client_codes/);
  });
  it.each([['abc'], ['0x65'], ['1e3'], [''], ['0'], ['-5']])(
    'código %s em revoked_client_codes → LANÇA',
    (chave) => {
      expect(() => parseIdentitySnapshot({ ...base, revoked_client_codes: [chave] })).toThrow(/código de cliente/);
    },
  );
  it('item não-string em revoked_client_codes → LANÇA', () => {
    expect(() => parseIdentitySnapshot({ ...base, revoked_client_codes: [105] })).toThrow(/código de cliente/);
  });
  it('código PROVADO e REVOGADO ao mesmo tempo → LANÇA (fail-open da RPC)', () => {
    expect(() =>
      parseIdentitySnapshot({ ...base, client_to_user: { '101': U1 }, revoked_client_codes: ['101'] }),
    ).toThrow(/fail-open/);
  });
});

describe('aplicarProvaPositivaNoCache — revogação (PR-2/A2)', () => {
  it('ACHADO A2 FECHADO: código revogado SAI do cache — é o que faz o dono ser refeito pela API', () => {
    // Sem isto o pedido continuaria de U1: a prova apenas deixaria de listar o código, e o cache da
    // view (que é vínculo por ausência de contraindicação) seguiria respondendo o dono obsoleto.
    const cache = new Map<number, string | null>([[101, U1], [202, U2]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map(), new Set([101]));
    expect(cache.has(101)).toBe(false);
    expect(cache.get(202)).toBe(U2);
    expect(r.revogados).toBe(1);
  });

  it('revogar um código que não está no cache não conta (o contador mede efeito, não intenção)', () => {
    const cache = new Map<number, string | null>([[202, U2]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map(), new Set([999]));
    expect(r.revogados).toBe(0);
    expect(cache.size).toBe(1);
  });

  it('revogação vence a prova se os conjuntos se cruzarem (fail-closed, não fail-open)', () => {
    // Por construção eles são disjuntos e o parser assere isso. Se um dia deixarem de ser, o cache
    // fica SEM entrada (força ida à API) em vez de manter um vínculo cuja regra não sabemos qual é.
    const cache = new Map<number, string | null>([[101, U1]]);
    aplicarProvaPositivaNoCache(cache, new Map([[101, U2]]), new Set([101]));
    expect(cache.has(101)).toBe(false);
  });

  it('revogação vazia → cache intacto (o estado inerte de hoje: nenhuma linha tem evidência)', () => {
    const cache = new Map<number, string | null>([[101, U1]]);
    const r = aplicarProvaPositivaNoCache(cache, new Map(), new Set());
    expect(cache.get(101)).toBe(U1);
    expect(r.revogados).toBe(0);
  });
});
