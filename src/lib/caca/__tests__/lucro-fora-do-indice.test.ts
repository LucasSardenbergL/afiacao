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
  // Três compradores com volume/fidelidade distintos. Um cenário COM lucro para todos e outro
  // SEM lucro para nenhum: a ordem tem de ser a mesma, porque 0,4 × 0,5 é constante somada a
  // todos (transformação afim crescente). Se algum dia isto quebrar, a correção deixa de ser
  // "avisar" e passa a ser "recalcular" — e o teste é quem avisa.
  const base = [
    comprador({ documento: 'A', volume: 3000, n_pedidos: 9, recencia_dias: 10 }),
    comprador({ documento: 'B', volume: 2000, n_pedidos: 5, recencia_dias: 40 }),
    comprador({ documento: 'C', volume: 500, n_pedidos: 2, recencia_dias: 200 }),
  ];

  it('B1 com lucro em todos vs sem lucro em nenhum → MESMA ordem', () => {
    // Lucro ANTI-correlacionado ao volume de propósito: se o termo de lucro ainda pesasse, ele
    // inverteria a ordem e o teste falharia. Isto é o controle que dá dente ao B2.
    const comLucro = base.map((c, i) => ({
      ...c,
      lucro_proxy: [10, 500, 9000][i],
      lucro_cobertura: 0.9,
    }));
    const semLucro = base; // proxy null + cobertura 0 = o mundo pós-REVOKE

    const ordemSem = selecionarMelhores(semLucro, { fracaoTop: 1 }).melhores.map((m) => m.documento);
    const ordemCom = selecionarMelhores(comLucro, { fracaoTop: 1 }).melhores.map((m) => m.documento);

    expect(ordemSem).toEqual(['A', 'B', 'C']);
    // O controle: COM lucro anti-correlacionado a ordem MUDA — prova que o termo pesa de verdade
    // e que o B2 abaixo não está medindo um índice que ignora lucro.
    expect(ordemCom).not.toEqual(ordemSem);
  });

  it('B2 sem lucro em nenhum, a ordem é a mesma que renormalizar os pesos daria', () => {
    const semLucro = base;
    const comImputacao = selecionarMelhores(semLucro, { fracaoTop: 1 }).melhores.map((m) => m.documento);
    // Renormalizar = descartar o termo de lucro e repartir seu peso entre os outros dois.
    const renormalizado = selecionarMelhores(semLucro, {
      fracaoTop: 1,
      pesoLucro: 0,
      pesoVolume: 0.5,
      pesoFidelidade: 0.5,
    }).melhores.map((m) => m.documento);

    expect(comImputacao).toEqual(renormalizado);
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
