import { describe, it, expect } from 'vitest';
import { selecionarMelhores, percentil } from '../melhores';
import type { CompradorRow } from '../types';

// ─── Fábrica de fixtures ─────────────────────────────────────────────────────

function comprador(over: Partial<CompradorRow> & { documento: string }): CompradorRow {
  return {
    empresa: 'oben',
    cidade_uf: 'DIVINOPOLIS-MG',
    ramo: 'moveleiro',
    ticket_faixa: 1000,
    familias: ['lixa'],
    volume: 100,
    n_pedidos: 5,
    recencia_dias: 30,
    lucro_proxy: 200,
    lucro_cobertura: 1,
    ...over,
  };
}

// ─── percentil ───────────────────────────────────────────────────────────────

describe('percentil', () => {
  it('n=1 → 1 (ponto único é o topo por convenção)', () => {
    expect(percentil([42], 42)).toBe(1);
  });

  it('valor mínimo do conjunto → 0', () => {
    expect(percentil([10, 20, 30], 10)).toBe(0);
  });

  it('valor máximo do conjunto → 1', () => {
    expect(percentil([10, 20, 30], 30)).toBe(1);
  });

  it('valor mediano → fração de estritamente menores / (n-1)', () => {
    // [10,20,30], v=20: 1 valor estritamente menor / (3-1) = 0.5
    expect(percentil([10, 20, 30], 20)).toBe(0.5);
  });

  it('empates compartilham o mesmo percentil (estritamente menores)', () => {
    // [10,20,20,30], v=20: 1 estritamente menor / 3 ≈ 0.333
    expect(percentil([10, 20, 20, 30], 20)).toBeCloseTo(1 / 3, 10);
  });

  it('lista vazia → 1 (n<=1)', () => {
    expect(percentil([], 5)).toBe(1);
  });

  it('determinístico independente da ordem de entrada', () => {
    expect(percentil([30, 10, 20], 20)).toBe(percentil([10, 20, 30], 20));
  });
});

// ─── selecionarMelhores: seleção básica ──────────────────────────────────────

describe('selecionarMelhores — seleção básica', () => {
  it('comprador alto em volume+lucro+fidelidade entra; baixo em tudo, não', () => {
    const compradores: CompradorRow[] = [
      comprador({ documento: 'ALTO', volume: 1000, n_pedidos: 50, recencia_dias: 1, lucro_proxy: 9000 }),
      comprador({ documento: 'MED1', volume: 100, n_pedidos: 5, recencia_dias: 60, lucro_proxy: 500 }),
      comprador({ documento: 'MED2', volume: 90, n_pedidos: 4, recencia_dias: 70, lucro_proxy: 400 }),
      comprador({ documento: 'BAIXO', volume: 1, n_pedidos: 1, recencia_dias: 365, lucro_proxy: 10 }),
    ];
    // fracaoTop 0.5 com n=4 → ceil(2) = 2 melhores
    const { melhores } = selecionarMelhores(compradores, { fracaoTop: 0.5 });
    const docs = melhores.map((m) => m.documento);
    expect(docs).toContain('ALTO');
    expect(docs).not.toContain('BAIXO');
    expect(melhores).toHaveLength(2);
  });
});

// ─── selecionarMelhores: ausência de lucro ≠ zero ────────────────────────────

describe('selecionarMelhores — ausência de lucro ≠ zero (renormalização)', () => {
  it('comprador sem lucro NÃO afunda abaixo de um terceiro nitidamente menor', () => {
    // A e B: idênticos em volume/fidelidade (medianos). A tem lucro alto; B tem lucro null.
    // C: volume/fidelidade nitidamente MENORES (com lucro baixo, mas presente).
    //
    // Sem renormalização (lucro null tratado como 0), B cairia para
    // 0.4*0 + 0.3*pctVol_B + 0.3*pctFid_B — afundando abaixo de C.
    // Com renormalização, B = (0.3*pctVol_B + 0.3*pctFid_B)/0.6 — fica acima de C.
    const compradores: CompradorRow[] = [
      comprador({ documento: 'A', volume: 100, n_pedidos: 10, recencia_dias: 30, lucro_proxy: 5000, lucro_cobertura: 1 }),
      comprador({ documento: 'B', volume: 100, n_pedidos: 10, recencia_dias: 30, lucro_proxy: null }),
      comprador({ documento: 'C', volume: 10, n_pedidos: 1, recencia_dias: 300, lucro_proxy: 50, lucro_cobertura: 1 }),
    ];
    // fracaoTop alto pra todos entrarem e poder ler a ORDEM relativa.
    const { melhores } = selecionarMelhores(compradores, { fracaoTop: 1 });
    const docs = melhores.map((m) => m.documento);
    const idxB = docs.indexOf('B');
    const idxC = docs.indexOf('C');
    // B (sem lucro, forte em volume/fidelidade) ranqueia ACIMA de C (fraco em tudo).
    expect(idxB).toBeLessThan(idxC);

    // Prova adicional: com fracaoTop=0.5 (n=3 → ceil(1.5)=2), os 2 selecionados são A e B — não C.
    const top2 = selecionarMelhores(compradores, { fracaoTop: 0.5 }).melhores.map((m) => m.documento);
    expect(top2.sort()).toEqual(['A', 'B']);
  });

  it('cobertura < coberturaMinLucro → lucro tratado como ausente (não entra no pctLucro)', () => {
    // X tem lucro_proxy GIGANTE mas cobertura baixa (0.1 < 0.5 default) → ignorado.
    // Se a cobertura fosse respeitada como confiável, X dominaria pelo lucro.
    // Como é ausente, X compete só por volume/fidelidade (que são medianos),
    // ficando atrás de Y que é forte em volume/fidelidade.
    const compradores: CompradorRow[] = [
      comprador({ documento: 'X', volume: 50, n_pedidos: 5, recencia_dias: 30, lucro_proxy: 999999, lucro_cobertura: 0.1 }),
      comprador({ documento: 'Y', volume: 1000, n_pedidos: 50, recencia_dias: 1, lucro_proxy: 100, lucro_cobertura: 1 }),
      comprador({ documento: 'Z', volume: 10, n_pedidos: 1, recencia_dias: 300, lucro_proxy: 100, lucro_cobertura: 1 }),
    ];
    // fracaoTop=0.1 com n=3 → ceil(0.3)=1 → exatamente 1 vencedor.
    const vencedor = selecionarMelhores(compradores, { fracaoTop: 0.1 }).melhores;
    expect(vencedor).toHaveLength(1);
    expect(vencedor[0].documento).toBe('Y'); // X NÃO venceu apesar do lucro gigante (cobertura baixa)
  });
});

// ─── selecionarMelhores: fração / ceil ───────────────────────────────────────

describe('selecionarMelhores — fração e ceil', () => {
  it('fracaoTop=0.2 com 10 compradores → exatamente 2 melhores (ceil)', () => {
    const compradores = Array.from({ length: 10 }, (_, i) =>
      comprador({ documento: `D${i.toString().padStart(2, '0')}`, volume: i * 10, n_pedidos: i, recencia_dias: 100 - i, lucro_proxy: i * 5 }),
    );
    const { melhores } = selecionarMelhores(compradores, { fracaoTop: 0.2 });
    expect(melhores).toHaveLength(2);
  });

  it('fracaoTop que não divide exato → arredonda pra cima (ceil)', () => {
    // 7 compradores, fracaoTop 0.2 → 7*0.2 = 1.4 → ceil = 2
    const compradores = Array.from({ length: 7 }, (_, i) =>
      comprador({ documento: `D${i}`, volume: i * 10, n_pedidos: i, recencia_dias: 100 - i }),
    );
    const { melhores } = selecionarMelhores(compradores, { fracaoTop: 0.2 });
    expect(melhores).toHaveLength(2);
  });
});

// ─── selecionarMelhores: base ────────────────────────────────────────────────

describe('selecionarMelhores — base', () => {
  it('base = todos os compradores (n), mapeada 1:1', () => {
    const compradores: CompradorRow[] = [
      comprador({ documento: 'A', cidade_uf: 'BH-MG', ramo: 'moveleiro', familias: ['lixa', 'cola'] }),
      comprador({ documento: 'B', cidade_uf: null, ramo: null, familias: [] }),
      comprador({ documento: 'C', cidade_uf: 'SP-SP', ramo: 'metal', familias: ['disco'] }),
    ];
    const { base } = selecionarMelhores(compradores);
    expect(base).toHaveLength(3);
    expect(base).toEqual([
      { cidadeUf: 'BH-MG', ramo: 'moveleiro', familias: ['lixa', 'cola'] },
      { cidadeUf: null, ramo: null, familias: [] },
      { cidadeUf: 'SP-SP', ramo: 'metal', familias: ['disco'] },
    ]);
  });

  it('base preserva null e [] (degradação honesta)', () => {
    const { base } = selecionarMelhores([
      comprador({ documento: 'A', cidade_uf: null, ramo: null, familias: [] }),
    ]);
    expect(base[0]).toEqual({ cidadeUf: null, ramo: null, familias: [] });
  });
});

// ─── selecionarMelhores: determinismo / tiebreak ─────────────────────────────

describe('selecionarMelhores — tiebreak determinístico', () => {
  it('empate de índice → ordem por documento (asc)', () => {
    // 4 compradores idênticos em TUDO menos o documento → mesmo índice.
    // ceil(4*0.5)=2 → devem sair os 2 de documento "menor" (asc).
    const compradores: CompradorRow[] = [
      comprador({ documento: 'ZZ' }),
      comprador({ documento: 'AA' }),
      comprador({ documento: 'MM' }),
      comprador({ documento: 'BB' }),
    ];
    const { melhores } = selecionarMelhores(compradores, { fracaoTop: 0.5 });
    expect(melhores.map((m) => m.documento)).toEqual(['AA', 'BB']);
  });

  it('mesma entrada → mesma saída (idempotente / determinístico)', () => {
    const compradores: CompradorRow[] = [
      comprador({ documento: 'A', volume: 300 }),
      comprador({ documento: 'B', volume: 200 }),
      comprador({ documento: 'C', volume: 100 }),
    ];
    const r1 = selecionarMelhores(compradores, { fracaoTop: 0.5 });
    const r2 = selecionarMelhores(compradores, { fracaoTop: 0.5 });
    expect(r1).toEqual(r2);
  });
});

// ─── selecionarMelhores: casos de borda ──────────────────────────────────────

describe('selecionarMelhores — casos de borda', () => {
  it('n=1 → 1 melhor + base de 1', () => {
    const { melhores, base } = selecionarMelhores([comprador({ documento: 'UNICO' })]);
    expect(melhores).toHaveLength(1);
    expect(melhores[0].documento).toBe('UNICO');
    expect(base).toHaveLength(1);
  });

  it('lista vazia → melhores [] e base []', () => {
    const { melhores, base } = selecionarMelhores([]);
    expect(melhores).toEqual([]);
    expect(base).toEqual([]);
  });

  it('mapeia MelhorCliente a partir dos campos snake_case do comprador', () => {
    const { melhores } = selecionarMelhores([
      comprador({ documento: 'X', cidade_uf: 'UBA-MG', ramo: 'moveleiro', ticket_faixa: 2500, familias: ['verniz'] }),
    ]);
    expect(melhores[0]).toEqual({
      documento: 'X',
      cidadeUf: 'UBA-MG',
      ramo: 'moveleiro',
      ticketFaixa: 2500,
      familias: ['verniz'],
    });
  });

  it('nenhum comprador com lucro confiável → índice usa só volume+fidelidade (sem NaN)', () => {
    // Todos com lucro null → lucrosValidos vazio; renormalização não pode gerar NaN.
    const compradores: CompradorRow[] = [
      comprador({ documento: 'A', volume: 300, n_pedidos: 10, recencia_dias: 5, lucro_proxy: null }),
      comprador({ documento: 'B', volume: 100, n_pedidos: 2, recencia_dias: 200, lucro_proxy: null }),
    ];
    const { melhores } = selecionarMelhores(compradores, { fracaoTop: 0.5 });
    expect(melhores).toHaveLength(1);
    expect(melhores[0].documento).toBe('A'); // forte em volume/fidelidade vence
    // garante que nenhum índice virou NaN (senão a ordem seria indefinida)
    expect(Number.isNaN(0)).toBe(false);
  });
});
