import { describe, it, expect } from 'vitest';
import {
  selecionarMelhores,
  lucroConfiavel,
  empresasSemLucroConfiavel,
  COBERTURA_MIN_LUCRO,
} from '../melhores';
import type { CompradorRow } from '../types';

/**
 * FU4-F fase 3 — a Caça DECLARA quando o componente de lucro sai do índice.
 *
 * `v_caca_compradores` é `security_invoker` e faz `LEFT JOIN public.product_costs`. Depois do
 * REVOKE (migration 20260725130000) quem não tem `private.cap_custo_ler` NÃO recebe 403: a RLS
 * filtra a tabela para zero linhas e o LEFT JOIN devolve NULL. `lucro_proxy` vira null,
 * `lucro_cobertura` vira 0 (o `COALESCE(...,0)` do numerador), `lucroConfiavel` fica falso em
 * TODAS as linhas e o índice perde 0,4 do peso sem sinal nenhum — "ausente ≠ zero" falhando
 * ABERTO. Grep de `src/` não enxerga isso: a dependência vive no banco.
 *
 * O que estes testes fixam é o desenho da correção:
 *   1. a ORDEM não muda (por isso a correção é DECLARAR, não recalcular) — B1/B2;
 *   2. a detecção é POR EMPRESA (o índice é calculado por empresa-alvo) — C1..C4;
 *   3. o limiar é UM só, compartilhado entre quem calcula e quem avisa — A3.
 */

const comprador = (over: Partial<CompradorRow> & { documento: string }): CompradorRow => ({
  empresa: 'oben',
  cidade_uf: 'Curitiba-PR',
  ramo: null,
  ticket_faixa: 100,
  familias: [],
  volume: 1000,
  n_pedidos: 5,
  recencia_dias: 30,
  lucro_proxy: null,
  lucro_cobertura: 0,
  ...over,
});

describe('lucroConfiavel — o predicado é um só', () => {
  it('A1 exige proxy presente E cobertura suficiente', () => {
    expect(lucroConfiavel({ lucro_proxy: 500, lucro_cobertura: 0.8 })).toBe(true);
    expect(lucroConfiavel({ lucro_proxy: null, lucro_cobertura: 0.9 })).toBe(false);
    expect(lucroConfiavel({ lucro_proxy: 500, lucro_cobertura: 0.4 })).toBe(false);
  });

  it('A2 o cenário do REVOKE (proxy null + cobertura 0) é o caso NEGATIVO', () => {
    // É exatamente o que a view devolve para quem não tem cap_custo_ler.
    expect(lucroConfiavel({ lucro_proxy: null, lucro_cobertura: 0 })).toBe(false);
  });

  it('A3 o limiar exportado é o mesmo que o cálculo usa (fonte única)', () => {
    expect(lucroConfiavel({ lucro_proxy: 1, lucro_cobertura: COBERTURA_MIN_LUCRO })).toBe(true);
    expect(lucroConfiavel({ lucro_proxy: 1, lucro_cobertura: COBERTURA_MIN_LUCRO - 0.01 })).toBe(false);
  });
});

describe('perder o lucro NÃO reordena — por isso a correção é declarar', () => {
  const ordem = (linhas: CompradorRow[], opts = {}) =>
    selecionarMelhores(linhas, { fracaoTop: 1, ...opts }).melhores.map((m) => m.documento);

  // ⚠️ FIXTURE CALIBRADO, e o cuidado aqui foi comprado com um vermelho: a primeira versão usava
  // volume e fidelidade CORRELACIONADOS (A melhor nos dois, C pior nos dois). Ali o lucro nunca
  // inverte nada — 0,3 + 0,3 domina 0,4 — e o "controle" ficava verde por construção, medindo o
  // fixture em vez do índice. Aqui volume e fidelidade são ANTI-correlacionados de propósito, de
  // modo que os dois somem 0,3 para os três compradores: o termo de lucro fica sendo o ÚNICO
  // discriminante, que é a condição para o controle ter dente.
  //
  //   A: volume topo   (pct 1,0) · fidelidade fundo (0,0) → 0,3×1,0 + 0,3×0,0 = 0,3
  //   B: volume fundo  (pct 0,0) · fidelidade topo  (1,0) → 0,3×0,0 + 0,3×1,0 = 0,3
  //   C: volume meio   (pct 0,5) · fidelidade meio  (0,5) → 0,3×0,5 + 0,3×0,5 = 0,3
  const base: CompradorRow[] = [
    comprador({ documento: 'A', volume: 3000, n_pedidos: 1, recencia_dias: 300 }),
    comprador({ documento: 'B', volume: 500, n_pedidos: 9, recencia_dias: 10 }),
    comprador({ documento: 'C', volume: 1500, n_pedidos: 5, recencia_dias: 100 }),
  ];

  it('B1 (controle): o termo de lucro PESA — com ele a ordem é outra', () => {
    // Lucro crescente de A para B: pctLucro 0 / 0,5 / 1 ⇒ índices 0,3 / 0,5 / 0,7 ⇒ B, C, A.
    // Sem este assert, o B2 abaixo passaria mesmo num índice que ignorasse lucro por completo.
    const comLucro = base.map((c) => ({
      ...c,
      lucro_proxy: { A: 10, C: 500, B: 9000 }[c.documento] as number,
      lucro_cobertura: 0.9,
    }));
    expect(ordem(comLucro)).toEqual(['B', 'C', 'A']);
    expect(ordem(base)).not.toEqual(ordem(comLucro));
  });

  it('B2 sem lucro em nenhum, a ordem é a MESMA que renormalizar os pesos daria', () => {
    // A afirmação que sustenta "declarar, não recalcular": com pctLucro imputado em 0,5 para
    // TODOS, `0,4 × 0,5` é uma constante somada a todos — transformação afim crescente, que
    // preserva ordem e empates. Renormalizar (descartar o termo e repartir o peso) produz o
    // mesmo ranking. Se algum dia isto quebrar, a correção deixa de ser avisar.
    expect(ordem(base)).toEqual(
      ordem(base, { pesoLucro: 0, pesoVolume: 0.5, pesoFidelidade: 0.5 }),
    );
  });

  it('B3 a igualdade do B2 não é acidente do fixture simétrico', () => {
    // O fixture do B2 empata volume+fidelidade nos três; um cético diria que a igualdade vem
    // dali. Aqui os três são distintos em volume E fidelidade — e a conclusão se mantém.
    const distintos: CompradorRow[] = [
      comprador({ documento: 'X', volume: 9000, n_pedidos: 12, recencia_dias: 5 }),
      comprador({ documento: 'Y', volume: 4000, n_pedidos: 7, recencia_dias: 60 }),
      comprador({ documento: 'Z', volume: 800, n_pedidos: 2, recencia_dias: 250 }),
    ];
    expect(ordem(distintos)).toEqual(['X', 'Y', 'Z']);
    expect(ordem(distintos)).toEqual(
      ordem(distintos, { pesoLucro: 0, pesoVolume: 0.5, pesoFidelidade: 0.5 }),
    );
  });
});

describe('empresasSemLucroConfiavel — o aviso é POR EMPRESA', () => {
  it('C1 empresa com ao menos UM comprador com lucro não entra na lista', () => {
    const linhas = [
      comprador({ documento: 'A', empresa: 'oben', lucro_proxy: 100, lucro_cobertura: 0.9 }),
      comprador({ documento: 'B', empresa: 'oben' }),
    ];
    expect(empresasSemLucroConfiavel(linhas)).toEqual([]);
  });

  it('C2 caso MISTO: só a empresa cega entra (um sinal global esconderia)', () => {
    const linhas = [
      comprador({ documento: 'A', empresa: 'oben', lucro_proxy: 100, lucro_cobertura: 0.9 }),
      comprador({ documento: 'B', empresa: 'colacor' }),
      comprador({ documento: 'C', empresa: 'colacor' }),
    ];
    expect(empresasSemLucroConfiavel(linhas)).toEqual(['colacor']);
  });

  it('C3 o mundo pós-REVOKE: TODAS as empresas entram, em ordem estável', () => {
    const linhas = [
      comprador({ documento: 'A', empresa: 'oben' }),
      comprador({ documento: 'B', empresa: 'colacor' }),
    ];
    expect(empresasSemLucroConfiavel(linhas)).toEqual(['colacor', 'oben']);
  });

  it('C4 empresa sem comprador nenhum NÃO vira alarme (lista vazia → nada a avisar)', () => {
    expect(empresasSemLucroConfiavel([])).toEqual([]);
  });

  it('C5 cobertura insuficiente conta como cega, mesmo com proxy presente', () => {
    const linhas = [
      comprador({ documento: 'A', empresa: 'oben', lucro_proxy: 100, lucro_cobertura: 0.2 }),
    ];
    expect(empresasSemLucroConfiavel(linhas)).toEqual(['oben']);
  });
});
