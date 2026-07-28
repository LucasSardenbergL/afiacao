import { describe, it, expect, vi } from 'vitest';
import { paginateAll, filterAndRankProducts } from '../catalog-helpers';
import type { Product } from '../types';

let idc = 0;
const mk = (over: Partial<Product> = {}): Product => ({
  id: `id-${idc++}`,
  codigo: 'PRD0000',
  descricao: 'PRODUTO X',
  unidade: 'UN',
  valor_unitario: 10,
  estoque: 0,
  ativo: true,
  omie_codigo_produto: 1,
  ...over,
});

describe('paginateAll', () => {
  it('reúne todas as páginas e para na página parcial', async () => {
    const pagina0 = Array.from({ length: 1000 }, (_, i) => mk({ id: `p0-${i}` }));
    const pagina1 = Array.from({ length: 7 }, (_, i) => mk({ id: `p1-${i}` }));
    const fetchPage = vi.fn(async (from: number) => (from === 0 ? pagina0 : pagina1));

    const all = await paginateAll(fetchPage, 1000);

    expect(all).toHaveLength(1007);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 999);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 1000, 1999);
  });

  it('REGRESSÃO do cap: produto na 2ª página (posição > 1000) é reunido, não perdido', async () => {
    const pagina0 = Array.from({ length: 1000 }, (_, i) => mk({ id: `p0-${i}`, descricao: `AAA ${i}` }));
    const primer6264 = mk({ id: 'real-6264', codigo: 'PRD00500', descricao: 'PRIMER PU BRANCO FL.6264.02GL' });
    const pagina1 = [primer6264, ...Array.from({ length: 4 }, (_, i) => mk({ id: `p1-${i}` }))];
    const fetchPage = async (from: number) => (from === 0 ? pagina0 : pagina1);

    const all = await paginateAll(fetchPage, 1000);

    expect(all).toHaveLength(1005);
    expect(all.find((p) => p.id === 'real-6264')).toBeDefined();
  });

  it('página exatamente cheia seguida de vazia: para corretamente', async () => {
    const pagina0 = Array.from({ length: 1000 }, (_, i) => mk({ id: `p0-${i}` }));
    const fetchPage = vi.fn(async (from: number) => (from === 0 ? pagina0 : []));

    const all = await paginateAll(fetchPage, 1000);

    expect(all).toHaveLength(1000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('propaga erro de página e NÃO retorna catálogo parcial', async () => {
    const fetchPage = async (from: number) => {
      if (from === 0) return Array.from({ length: 1000 }, (_, i) => mk({ id: `p0-${i}` }));
      throw new Error('falha de rede na página 2');
    };

    await expect(paginateAll(fetchPage, 1000)).rejects.toThrow('falha de rede');
  });

  it('atingir maxPages LANÇA (não devolve parcial) e ainda para — o guard anti-loop continua', async () => {
    const fetchPage = vi.fn(async () => Array.from({ length: 1000 }, (_, i) => mk({ id: `x-${i}` })));

    // Lançar é a única leitura honesta: ao esgotar o teto com a página CHEIA, o
    // helper não sabe se acabou ou se há cauda — devolver o acumulado afirmaria
    // completude que ele não tem (era o furo: 3000 indistinguível do catálogo inteiro).
    await expect(paginateAll(fetchPage, 1000, 3)).rejects.toThrow(/maxPages/);
    // E o loop infinito segue evitado: parou nas 3 páginas, não iterou pra sempre.
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('a mensagem do teto carrega o diagnóstico (teto e linhas lidas) pra triagem', async () => {
    const fetchPage = async () => Array.from({ length: 10 }, (_, i) => mk({ id: `y-${i}` }));

    await expect(paginateAll(fetchPage, 10, 2)).rejects.toThrow(/2 páginas.*20 linhas/);
  });
});

const ctxNoPriority = { isPreviouslyPurchased: () => false, shouldPrioritize: false };

describe('filterAndRankProducts', () => {
  it('REGRESSÃO 6264: acha o item mesmo na posição alfabética alta da lista completa', () => {
    const fillers = Array.from({ length: 1500 }, (_, i) =>
      mk({ id: `f-${i}`, descricao: `ABRASIVO ${String(i).padStart(4, '0')}` }),
    );
    const primer = mk({ id: 'real-6264', codigo: 'PRD00500', descricao: 'PRIMER PU BRANCO FL.6264.02GL' });
    const all = [...fillers, primer];

    const out = filterAndRankProducts(all, '6264', ctxNoPriority);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('real-6264');
  });

  it('busca casa no código', () => {
    const all = [mk({ id: 'a', codigo: 'PRD03576', descricao: 'PRIMER PU FL.6264.02KGBH' }), mk({ id: 'b', codigo: 'PRD9999' })];
    expect(filterAndRankProducts(all, 'PRD03576', ctxNoPriority).map((p) => p.id)).toEqual(['a']);
  });

  it('busca casa no omie_codigo_produto numérico (digitou o código interno)', () => {
    const all = [
      mk({ id: 'a', codigo: 'PRDXXX', descricao: 'SEM NUMERO', omie_codigo_produto: 6264 }),
      mk({ id: 'b', codigo: 'PRDYYY', descricao: 'OUTRO', omie_codigo_produto: 99 }),
    ];
    expect(filterAndRankProducts(all, '6264', ctxNoPriority).map((p) => p.id)).toEqual(['a']);
  });

  it('busca é case-insensitive', () => {
    const all = [mk({ id: 'a', descricao: 'Primer PU Branco' })];
    expect(filterAndRankProducts(all, 'primer', ctxNoPriority).map((p) => p.id)).toEqual(['a']);
  });

  it('prioriza comprado > ativo > alfabético', () => {
    const p1 = mk({ id: 'p1', ativo: true, descricao: 'B nao comprado' });
    const p2 = mk({ id: 'p2', ativo: false, descricao: 'Z comprado inativo' });
    const p3 = mk({ id: 'p3', ativo: true, descricao: 'Y comprado ativo' });
    const ctx = { isPreviouslyPurchased: (p: Product) => p.id === 'p2' || p.id === 'p3', shouldPrioritize: true };

    const out = filterAndRankProducts([p1, p2, p3], '', ctx);

    expect(out.map((p) => p.id)).toEqual(['p3', 'p2', 'p1']);
  });

  it('desempate determinístico por id quando a descrição é idêntica', () => {
    const a = mk({ id: 'zzz', descricao: 'IGUAL' });
    const b = mk({ id: 'aaa', descricao: 'IGUAL' });
    const out = filterAndRankProducts([a, b], '', ctxNoPriority);
    expect(out.map((p) => p.id)).toEqual(['aaa', 'zzz']);
  });

  it('busca vazia retorna top-N priorizado respeitando o limite', () => {
    const all = Array.from({ length: 60 }, (_, i) => mk({ id: `n-${i}`, descricao: `ITEM ${String(i).padStart(3, '0')}` }));
    expect(filterAndRankProducts(all, '', ctxNoPriority, 50)).toHaveLength(50);
  });
});
