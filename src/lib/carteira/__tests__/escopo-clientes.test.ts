import { describe, it, expect } from 'vitest';
import {
  resolveModoEscopo, chunk, marcarCobertura, ordenarPorNome, paginarTudo, coletarEmLotes,
  hashIds, ownersAtivosDoAlvo,
} from '@/lib/carteira/escopo-clientes';

describe('resolveModoEscopo', () => {
  it.each([
    [{ displayIsMaster: true, displayIsGestorComercial: false, displayIsSalesOnly: false }, 'completa'],
    [{ displayIsMaster: false, displayIsGestorComercial: true, displayIsSalesOnly: false }, 'completa'],
    [{ displayIsMaster: false, displayIsGestorComercial: false, displayIsSalesOnly: false }, 'carteira'],
    [{ displayIsMaster: false, displayIsGestorComercial: false, displayIsSalesOnly: true }, 'carteira'],
    // sales-only é a restrição mais forte: ganha mesmo com role gerencial/master
    [{ displayIsMaster: true, displayIsGestorComercial: true, displayIsSalesOnly: true }, 'carteira'],
  ] as const)('flags %o → %s', (flags, esperado) => {
    expect(resolveModoEscopo(flags)).toBe(esperado);
  });
});

describe('chunk', () => {
  it('divide com resto', () => expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]));
  it('lista vazia', () => expect(chunk([], 3)).toEqual([]));
  it('size maior que a lista', () => expect(chunk([1, 2], 5)).toEqual([[1, 2]]));
  it('size inválido lança', () => expect(() => chunk([1], 0)).toThrow());
});

describe('marcarCobertura', () => {
  it('marca coberto_de quando owner ≠ baseId, null quando =', () => {
    const profiles = [{ user_id: 'c1', name: 'A' }, { user_id: 'c2', name: 'B' }];
    const ownerById = new Map([['c1', 'me'], ['c2', 'outro']]);
    const out = marcarCobertura(profiles, ownerById, 'me');
    expect(out[0].coberto_de).toBeNull();
    expect(out[1].coberto_de).toBe('outro');
  });
  it('owner ausente no mapa → coberto_de null', () => {
    const out = marcarCobertura([{ user_id: 'x', name: 'X' }], new Map(), 'me');
    expect(out[0].coberto_de).toBeNull();
  });
});

describe('ordenarPorNome', () => {
  it('ordena respeitando acento e caixa pt-BR', () => {
    const out = ordenarPorNome([{ name: 'Bruno' }, { name: 'Ávila' }, { name: 'ana' }]);
    expect(out.map((x) => x.name)).toEqual(['ana', 'Ávila', 'Bruno']);
  });
});

describe('paginarTudo', () => {
  it('junta páginas até uma incompleta', async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => i),
      Array.from({ length: 1000 }, (_, i) => 1000 + i),
      [2000, 2001],
    ];
    let call = 0;
    const all = await paginarTudo(async () => pages[call++] ?? [], 1000);
    expect(all).toHaveLength(2002);
  });
  it('para na página vazia quando o total é múltiplo do pageSize', async () => {
    const pages = [[1, 2], [3, 4], []];
    let call = 0;
    const all = await paginarTudo(async () => pages[call++] ?? [], 2);
    expect(all).toEqual([1, 2, 3, 4]);
  });
});

describe('coletarEmLotes', () => {
  it('divide em lotes e concatena na ordem', async () => {
    const lotesVistos: number[][] = [];
    const out = await coletarEmLotes([1, 2, 3, 4, 5], 2, async (lote) => {
      lotesVistos.push(lote);
      return lote.map((x) => x * 10);
    });
    expect(lotesVistos).toEqual([[1, 2], [3, 4], [5]]);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });
  it('propaga erro de um lote', async () => {
    await expect(
      coletarEmLotes([1, 2, 3], 2, async (lote) => {
        if (lote.includes(3)) throw new Error('boom');
        return lote;
      }),
    ).rejects.toThrow('boom');
  });
  it('lista vazia → []', async () => {
    expect(await coletarEmLotes([], 2, async () => [99])).toEqual([]);
  });
});

describe('hashIds', () => {
  it('mesmos ids → mesmo hash; um id diferente (mesma length) → hash diferente', () => {
    expect(hashIds(['a', 'b'])).toBe(hashIds(['a', 'b']));
    expect(hashIds(['a', 'b'])).not.toBe(hashIds(['a', 'c']));
  });
  it('a contagem entra no hash (mesmo prefixo, tamanhos diferentes)', () => {
    expect(hashIds(['a'])).not.toBe(hashIds(['a', 'a']));
  });
  it('lista vazia → "0:0"', () => expect(hashIds([])).toBe('0:0'));
});

describe('ownersAtivosDoAlvo', () => {
  const NOW = '2026-06-13T12:00:00Z';
  it('sem cobertura → só o alvo', () => {
    expect(ownersAtivosDoAlvo([], 'alvo', NOW)).toEqual(['alvo']);
  });
  it('cobertura sem validade e ainda-válida entram; expirada sai', () => {
    const rows = [
      { covered_user_id: 'A', valid_until: null },                  // sem validade → entra
      { covered_user_id: 'B', valid_until: '2026-06-20T00:00:00Z' }, // válida até o futuro → entra
      { covered_user_id: 'C', valid_until: '2026-06-01T00:00:00Z' }, // já expirou → sai
    ];
    expect(ownersAtivosDoAlvo(rows, 'alvo', NOW)).toEqual(['alvo', 'A', 'B']);
  });
});
