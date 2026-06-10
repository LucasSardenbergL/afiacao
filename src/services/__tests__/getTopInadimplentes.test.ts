import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Teste de contrato do getTopInadimplentes (ranking de inadimplentes do cockpit
 * /financeiro). Irmão dos bugs #719/#720: a query de títulos ATRASADO não tinha
 * .range() → o PostgREST capa em 1000 linhas e o ranking considerava só os 1000
 * primeiros títulos (a oben tem ~11k CR abertos) — um devedor grande com títulos
 * "depois" da 1ª página sumia do top.
 *
 * O mock reproduz o comportamento REAL do PostgREST: query sem .range() devolve
 * no máximo 1000 linhas; com .range(from, to) devolve a janela (capada em 1000).
 * Seeds têm valor_documento/valor_recebido/saldo coerentes (saldo é coluna
 * gerada), então os testes só falham por truncamento/filtro errado.
 */

type Row = Record<string, unknown>;

const state: {
  db: Record<string, Row[]>;
  errors: Record<string, { message: string } | undefined>;
} = { db: {}, errors: {} };

function makeBuilder(tabela: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let janela: { from: number; to: number } | null = null;
  const builder = {
    select: (_cols: string) => builder,
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    order: (_col: string) => builder,
    range: (from: number, to: number) => {
      janela = { from, to };
      return builder;
    },
    then: (
      resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const error = state.errors[tabela];
      if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);
      const matched = (state.db[tabela] ?? []).filter((r) => filters.every((f) => f(r)));
      // PostgREST real: max-rows de 1000 vale SEMPRE — sem range capa em 1000, e
      // com range a janela nunca passa de 1000 linhas (um `.range(0, 99999)` NÃO
      // fura o cap; só paginação de verdade soma tudo).
      const rows = janela
        ? matched.slice(janela.from, Math.min(janela.to + 1, janela.from + 1000))
        : matched.slice(0, 1000);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => makeBuilder(tabela) },
}));

import { getTopInadimplentes } from '@/services/financeiroService';

const atrasado = (company: string, nome: string, saldo: number, cnpj = ''): Row => ({
  company,
  status_titulo: 'ATRASADO',
  nome_cliente: nome,
  cnpj_cpf: cnpj,
  saldo,
  valor_documento: saldo,
  valor_recebido: 0,
});

describe('getTopInadimplentes (ranking de inadimplentes)', () => {
  beforeEach(() => {
    state.db = { fin_contas_receber: [] };
    state.errors = {};
  });

  it('considera TODOS os títulos ATRASADO mesmo acima do cap de 1000 do PostgREST', async () => {
    // 1000 títulos pulverizados na 1ª página + o maior devedor SÓ depois dela:
    // sem paginação o ranking nem enxerga o gigante.
    state.db.fin_contas_receber = [
      ...Array.from({ length: 1000 }, (_, i) => atrasado('oben', `Cliente ${i}`, 1)),
      ...Array.from({ length: 60 }, () => atrasado('oben', 'DEVEDOR GIGANTE', 100, '99888777000166')),
    ];

    const top = await getTopInadimplentes('oben');

    expect(top[0]).toEqual({
      nome: 'DEVEDOR GIGANTE',
      cnpj: '99888777000166',
      total_vencido: 60 * 100,
      qtd_titulos: 60,
    });
  });

  it('agrupa por cliente somando o saldo e ordena do maior pro menor', async () => {
    state.db.fin_contas_receber = [
      atrasado('oben', 'Beta', 50),
      // saldo (coluna gerada) ≠ valor cheio quando há recebimento parcial
      { ...atrasado('oben', 'Alfa', 70), valor_documento: 100, valor_recebido: 30 },
      atrasado('oben', 'Alfa', 30),
    ];

    const top = await getTopInadimplentes('oben');

    expect(top).toEqual([
      { nome: 'Alfa', cnpj: '', total_vencido: 100, qtd_titulos: 2 },
      { nome: 'Beta', cnpj: '', total_vencido: 50, qtd_titulos: 1 },
    ]);
  });

  it('só ATRASADO entra no ranking (A VENCER/RECEBIDO ficam fora)', async () => {
    state.db.fin_contas_receber = [
      atrasado('oben', 'Alfa', 10),
      { ...atrasado('oben', 'Alfa', 99), status_titulo: 'A VENCER' },
      { ...atrasado('oben', 'Alfa', 99), status_titulo: 'RECEBIDO' },
    ];

    const top = await getTopInadimplentes('oben');

    expect(top).toEqual([{ nome: 'Alfa', cnpj: '', total_vencido: 10, qtd_titulos: 1 }]);
  });

  it('filtra por empresa quando company != all e agrega tudo em all', async () => {
    state.db.fin_contas_receber = [
      atrasado('oben', 'Alfa', 10),
      atrasado('colacor', 'Beta', 20),
    ];

    expect(await getTopInadimplentes('oben')).toEqual([
      { nome: 'Alfa', cnpj: '', total_vencido: 10, qtd_titulos: 1 },
    ]);
    expect((await getTopInadimplentes('all')).map((r) => r.nome)).toEqual(['Beta', 'Alfa']);
  });

  it('identidade: nome vazio cai pro CNPJ; sem ambos vira "Cliente não identificado"', async () => {
    state.db.fin_contas_receber = [
      atrasado('oben', '  ', 30, '11222333000144'),
      atrasado('oben', '', 20),
    ];

    const top = await getTopInadimplentes('oben');

    expect(top).toEqual([
      { nome: 'CNPJ: 11222333000144', cnpj: '11222333000144', total_vencido: 30, qtd_titulos: 1 },
      { nome: 'Cliente não identificado', cnpj: '', total_vencido: 20, qtd_titulos: 1 },
    ]);
  });

  it('respeita o limit (default 10)', async () => {
    state.db.fin_contas_receber = Array.from({ length: 12 }, (_, i) =>
      atrasado('oben', `Cliente ${i}`, i + 1),
    );

    expect(await getTopInadimplentes('oben')).toHaveLength(10);
    expect(await getTopInadimplentes('oben', 3)).toHaveLength(3);
  });

  it('erro na query LANÇA Error real (ranking [] silencioso parecia "ninguém inadimplente")', async () => {
    state.errors.fin_contas_receber = { message: 'RLS negou' };
    await expect(getTopInadimplentes('oben')).rejects.toBeInstanceOf(Error);
  });
});
