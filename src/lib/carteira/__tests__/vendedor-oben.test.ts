// src/lib/carteira/__tests__/vendedor-oben.test.ts
import { describe, it, expect } from 'vitest';
import { resolverVendedorObenPorUser } from '../vendedor-oben';
import { computeCarteira } from '../rebuild-helpers';

describe('resolverVendedorObenPorUser (money-path P0-B-bis — vendedor da carteira vem da proof oben)', () => {
  it('user com 1 vendedor oben → resolve', () => {
    const r = resolverVendedorObenPorUser([{ user_id: 'u1', omie_codigo_vendedor: 42 }]);
    expect(r.vendedorPorUser.get('u1')).toBe(42);
    expect(r.ambiguos).toEqual([]);
  });

  it('user com vendedor NULL na proof → órfão (não entra no mapa, sem vendedor herdado)', () => {
    const r = resolverVendedorObenPorUser([{ user_id: 'u2', omie_codigo_vendedor: null }]);
    expect(r.vendedorPorUser.has('u2')).toBe(false);
    expect(r.ambiguos).toEqual([]);
  });

  it('AMBIGUIDADE (invariante 4): 2 vendedores oben DISTINTOS p/ o mesmo user → NÃO atribui (fail-closed) + registra', () => {
    const r = resolverVendedorObenPorUser([
      { user_id: 'u3', omie_codigo_vendedor: 42 },
      { user_id: 'u3', omie_codigo_vendedor: 99 },
    ]);
    // precisão>recall: ambíguo não vira assignment (cai pro Hunter no rebuild), nunca chuta o 1º
    expect(r.vendedorPorUser.has('u3')).toBe(false);
    expect(r.ambiguos).toEqual(['u3']);
  });

  it('mesmo vendedor repetido (duplicata de linha, NÃO ambiguidade) → resolve normal', () => {
    const r = resolverVendedorObenPorUser([
      { user_id: 'u4', omie_codigo_vendedor: 42 },
      { user_id: 'u4', omie_codigo_vendedor: 42 },
    ]);
    expect(r.vendedorPorUser.get('u4')).toBe(42);
    expect(r.ambiguos).toEqual([]);
  });

  it('código inválido (0, negativo, não-inteiro-seguro) → ignorado (órfão), nunca casa vendedor errado', () => {
    const r = resolverVendedorObenPorUser([
      { user_id: 'zero', omie_codigo_vendedor: 0 },
      { user_id: 'neg', omie_codigo_vendedor: -5 },
      { user_id: 'unsafe', omie_codigo_vendedor: 2 ** 53 }, // > MAX_SAFE_INTEGER → perde precisão
    ]);
    expect(r.vendedorPorUser.size).toBe(0);
    expect(r.ambiguos).toEqual([]);
  });

  it('código inválido + código válido no MESMO user → resolve pelo válido (o inválido não conta nem como ambiguidade)', () => {
    const r = resolverVendedorObenPorUser([
      { user_id: 'u5', omie_codigo_vendedor: 0 },
      { user_id: 'u5', omie_codigo_vendedor: 42 },
    ]);
    expect(r.vendedorPorUser.get('u5')).toBe(42);
    expect(r.ambiguos).toEqual([]);
  });

  it('múltiplos users independentes → resolvidos separadamente', () => {
    const r = resolverVendedorObenPorUser([
      { user_id: 'a', omie_codigo_vendedor: 1 },
      { user_id: 'b', omie_codigo_vendedor: 2 },
      { user_id: 'c', omie_codigo_vendedor: null },
      { user_id: 'd', omie_codigo_vendedor: 7 },
      { user_id: 'd', omie_codigo_vendedor: 8 }, // ambíguo
    ]);
    expect(r.vendedorPorUser.get('a')).toBe(1);
    expect(r.vendedorPorUser.get('b')).toBe(2);
    expect(r.vendedorPorUser.has('c')).toBe(false);
    expect(r.vendedorPorUser.has('d')).toBe(false);
    expect(r.ambiguos).toEqual(['d']);
  });

  it('user_id vazio/inválido → ignorado (não vira chave)', () => {
    const r = resolverVendedorObenPorUser([
      { user_id: '', omie_codigo_vendedor: 42 },
    ]);
    expect(r.vendedorPorUser.size).toBe(0);
    expect(r.ambiguos).toEqual([]);
  });

  it('entrada vazia → mapa vazio (não quebra)', () => {
    const r = resolverVendedorObenPorUser([]);
    expect(r.vendedorPorUser.size).toBe(0);
    expect(r.ambiguos).toEqual([]);
  });
});

// Integração resolverVendedorObenPorUser × computeCarteira — prova o INVARIANTE 2 (herança cross-account
// eliminada). Reproduz a montagem do edge: clientes[] = universo × vendedorPorUser(proof oben).
describe('invariante 2: herança cross-account ELIMINADA (clone colacor_sc não injeta vendedor no gêmeo oben)', () => {
  const HUNTER = 'hunter';
  const montar = (universo: string[], proofOben: { user_id: string; omie_codigo_vendedor: number | null }[]) => {
    const { vendedorPorUser } = resolverVendedorObenPorUser(proofOben);
    return universo.map((u) => ({ customer_user_id: u, omie_codigo_vendedor: vendedorPorUser.get(u) ?? null }));
  };

  it('clone só-colacor_sc (AUSENTE na proof oben) + gêmeo oben órfão → gêmeo NÃO herda, vai pro Hunter', () => {
    // Proof oben traz só o gêmeo, sem vendedor; o clone colacor_sc não tem linha oben (prod: 0/1633).
    const clientes = montar(['clone_sc', 'gemeo_oben'], [{ user_id: 'gemeo_oben', omie_codigo_vendedor: null }]);
    const r = computeCarteira(
      clientes,
      [{ omie_codigo_vendedor: 10, user_id: 'vendedora_sc' }], // a vendedora colacor_sc existe no map…
      HUNTER,
      new Map([['clone_sc', 'gemeo_oben']]),
    );
    const gemeo = r.assignments.find((a) => a.customer_user_id === 'gemeo_oben');
    // …mas o clone resolve AUSENTE → não injeta o código 10 → fail-closed: Hunter, não a vendedora_sc.
    expect(gemeo?.owner_user_id).toBe(HUNTER);
    expect(gemeo?.source).toBe('hunter_orphan');
  });

  it('CONTRASTE (o bug que existia × o novo): o modelo espelho herdava cross-account; o modelo proof NÃO', () => {
    // Modelo ANTIGO (espelho poluído): o clone trazia vendedor 10 (colacor_sc) → o gêmeo herdava (BUG).
    const rAntigo = computeCarteira(
      [{ customer_user_id: 'clone_sc', omie_codigo_vendedor: 10 }, { customer_user_id: 'gemeo_oben', omie_codigo_vendedor: null }],
      [{ omie_codigo_vendedor: 10, user_id: 'vendedora_sc' }],
      HUNTER,
      new Map([['clone_sc', 'gemeo_oben']]),
    );
    expect(rAntigo.assignments.find((a) => a.customer_user_id === 'gemeo_oben')?.owner_user_id).toBe('vendedora_sc'); // herança cross-account

    // Modelo NOVO (proof oben): o clone resolve ausente → o gêmeo NÃO herda o vendedor colacor_sc.
    const rNovo = computeCarteira(
      montar(['clone_sc', 'gemeo_oben'], [{ user_id: 'gemeo_oben', omie_codigo_vendedor: null }]),
      [{ omie_codigo_vendedor: 10, user_id: 'vendedora_sc' }],
      HUNTER,
      new Map([['clone_sc', 'gemeo_oben']]),
    );
    expect(rNovo.assignments.find((a) => a.customer_user_id === 'gemeo_oben')?.owner_user_id).toBe(HUNTER); // corrigido
  });

  it('caminho feliz preservado: gêmeo COM vendedor oben real → herda o vendedor OBEN, eligible=true', () => {
    const r = computeCarteira(
      montar(['clone_sc', 'gemeo_oben'], [{ user_id: 'gemeo_oben', omie_codigo_vendedor: 20 }]),
      [{ omie_codigo_vendedor: 20, user_id: 'vendedor_oben' }],
      HUNTER,
      new Map([['clone_sc', 'gemeo_oben']]),
    );
    const gemeo = r.assignments.find((a) => a.customer_user_id === 'gemeo_oben');
    expect(gemeo?.owner_user_id).toBe('vendedor_oben');
    expect(gemeo?.eligible).toBe(true);
  });

  it('user ambíguo na proof oben (2 vendedores) → não atribui → Hunter (precisão>recall)', () => {
    const r = computeCarteira(
      montar(['u_amb'], [
        { user_id: 'u_amb', omie_codigo_vendedor: 30 },
        { user_id: 'u_amb', omie_codigo_vendedor: 31 },
      ]),
      [{ omie_codigo_vendedor: 30, user_id: 'vA' }, { omie_codigo_vendedor: 31, user_id: 'vB' }],
      HUNTER,
    );
    expect(r.assignments.find((a) => a.customer_user_id === 'u_amb')?.owner_user_id).toBe(HUNTER);
  });
});
