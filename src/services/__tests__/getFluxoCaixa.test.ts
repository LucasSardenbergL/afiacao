import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Contrato do getFluxoCaixa (aba "Fluxo de Caixa" de /financeiro) — money-path.
 * A tela exibe caixa REALIZADO (o que entrou/saiu, de fin_movimentacoes) e
 * PREVISTO (a vencer, de fin_contas_receber/pagar) como número firme, sem
 * qualquer marca de incompletude. Três defeitos o tornavam menor em silêncio
 * (achado do Codex gpt-5.6-sol xhigh, 2026-07-21):
 *
 * 1. REALIZADO — o laço de paginação descartava o `error` (`const { data: page }`)
 *    e tratava página perdida (timeout/RLS/500) como fim da tabela. Um caixa
 *    menor não se anuncia como incompleto: some dinheiro e a tela segue firme.
 * 2. REALIZADO — `.order('data_movimento')` NÃO é ordem total. Medido em prod
 *    (psql-ro, 2026-07-21) na janela real da tela (6 meses atrás → 3 à frente):
 *    14.104 linhas, **100,0% delas em dias com empate** (maior dia = 305 linhas,
 *    média ~90). Com página de 1.000, toda fronteira de página cai DENTRO de um
 *    dia empatado ⇒ offset sem desempate estável pula e duplica linhas — e este
 *    erra sem erro nenhum, em todo load.
 * 3. PREVISTO — as queries de CR/CP descartavam o `error` E não paginavam:
 *    4.094 títulos de CR na janela (oben sozinha 2.897) contra a capa de 1.000
 *    ⇒ ~76% das entradas previstas sumiam na visão "todas".
 *
 * O mock reproduz o PostgREST real: capa de 1.000 linhas por request, e — o
 * ponto do caso 2 — ordem NÃO-determinística entre requests quando as chaves de
 * `.order()` empatam, que é precisamente o que o Postgres não promete.
 */

type Row = Record<string, unknown>;

const state: {
  db: Record<string, Row[]>;
  /** Falha na N-ésima requisição desta tabela (1-indexed). */
  falharNaRequisicao: Record<string, number | undefined>;
  /**
   * Resposta MALFORMADA (`{data:null, error:null}`) na N-ésima requisição (1-indexed).
   * Não é o mesmo que `falharNaRequisicao`: ali o PostgREST se anuncia (timeout/RLS/500),
   * aqui ele volta sem linhas E sem erro — o caso que `data ?? []` convertia em "fim da
   * tabela", encerrando o laço com o acumulado parcial.
   */
  dataNullNaRequisicao: Record<string, number | undefined>;
  requisicoes: Record<string, number>;
} = { db: {}, falharNaRequisicao: {}, dataNullNaRequisicao: {}, requisicoes: {} };

/**
 * Ordena como o Postgres: estável pelas chaves de ORDER BY e, dentro de um grupo
 * que EMPATA em todas elas, sem promessa de ordem entre requests. Rotacionar o
 * grupo por número de requisição é a forma determinística de reproduzir isso —
 * com desempate único (id) todo grupo tem 1 linha e a rotação vira no-op.
 */
function ordenarComoPostgres(linhas: Row[], chaves: string[], requisicao: number): Row[] {
  const chaveDe = (r: Row) => chaves.map((c) => String(r[c])).join('\u0000');
  const grupos = new Map<string, Row[]>();
  for (const r of linhas) {
    const k = chaveDe(r);
    const g = grupos.get(k) ?? [];
    g.push(r);
    grupos.set(k, g);
  }
  const saida: Row[] = [];
  for (const k of [...grupos.keys()].sort()) {
    const g = grupos.get(k)!;
    const desloc = g.length > 1 ? requisicao % g.length : 0;
    saida.push(...g.slice(desloc), ...g.slice(0, desloc));
  }
  return saida;
}

function makeBuilder(tabela: string) {
  const filtros: Array<(r: Row) => boolean> = [];
  const ordem: string[] = [];
  let janela: { from: number; to: number } | null = null;
  const builder = {
    select: (_cols: string) => builder,
    eq: (col: string, val: unknown) => {
      filtros.push((r) => r[col] === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      filtros.push((r) => vals.includes(r[col]));
      return builder;
    },
    gte: (col: string, val: string) => {
      filtros.push((r) => String(r[col]) >= val);
      return builder;
    },
    lte: (col: string, val: string) => {
      filtros.push((r) => String(r[col]) <= val);
      return builder;
    },
    order: (col: string, _opts?: unknown) => {
      ordem.push(col);
      return builder;
    },
    range: (from: number, to: number) => {
      janela = { from, to };
      return builder;
    },
    then: (
      resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const n = (state.requisicoes[tabela] = (state.requisicoes[tabela] ?? 0) + 1);
      if (state.falharNaRequisicao[tabela] === n) {
        const error = { message: `falha simulada na requisição ${n} de ${tabela}` };
        return Promise.resolve({ data: null, error }).then(resolve, reject);
      }
      if (state.dataNullNaRequisicao[tabela] === n) {
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      const casadas = (state.db[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
      const ordenadas = ordenarComoPostgres(casadas, ordem, n);
      // PostgREST real: a capa de 1.000 vale SEMPRE — sem range capa em 1.000, e
      // com range a janela nunca passa de 1.000 linhas.
      const rows = janela
        ? ordenadas.slice(janela.from, Math.min(janela.to + 1, janela.from + 1000))
        : ordenadas.slice(0, 1000);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (tabela: string) => makeBuilder(tabela) },
}));

import { getFluxoCaixa } from '@/services/financeiroService';

const INICIO = '2026-01-01';
const FIM = '2026-12-31';

/** Movimento de caixa realizado. `valor` distinto por linha: pular ou duplicar altera a soma. */
const mov = (i: number, dia: string, valor: number, tipo = 'E'): Row => ({
  id: `mov-${String(i).padStart(6, '0')}`,
  company: 'oben',
  data_movimento: dia,
  tipo,
  valor,
  omie_codigo_lancamento: 1000 + i,
});

const titulo = (i: number, dia: string, valor: number): Row => ({
  id: `cr-${String(i).padStart(6, '0')}`,
  company: 'oben',
  data_vencimento: dia,
  data_recebimento: null,
  valor_documento: valor,
  valor_recebido: 0,
  status_titulo: 'A VENCER',
});

const somaRealizadoEntradas = (fluxo: { entradas_realizadas: number }[]) =>
  fluxo.reduce((s, d) => s + d.entradas_realizadas, 0);
const somaPrevistoEntradas = (fluxo: { entradas_previstas: number }[]) =>
  fluxo.reduce((s, d) => s + d.entradas_previstas, 0);

describe('getFluxoCaixa — caixa REALIZADO (fin_movimentacoes)', () => {
  beforeEach(() => {
    state.db = { fin_movimentacoes: [], fin_contas_receber: [], fin_contas_pagar: [] };
    state.falharNaRequisicao = {};
    state.dataNullNaRequisicao = {};
    state.requisicoes = {};
  });

  it('erro numa página LANÇA — página perdida não vira fim da tabela', async () => {
    // 2.500 movimentos = 3 páginas. A 2ª falha (timeout/RLS/500): sem guard o laço
    // encerra e devolve ~40% do caixa como se fosse o caixa inteiro.
    state.db.fin_movimentacoes = Array.from({ length: 2500 }, (_, i) =>
      mov(i, `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, 10),
    );
    state.falharNaRequisicao.fin_movimentacoes = 2;

    await expect(getFluxoCaixa('oben', INICIO, FIM)).rejects.toBeInstanceOf(Error);
  });

  it('data:null SEM error numa página LANÇA — resposta malformada não é fim da tabela', async () => {
    // O mesmo defeito do caso acima por uma via que o `if (error)` não cobre: a resposta
    // volta sem linhas E sem erro, e o `data ?? []` a convertia em página vazia ⇒
    // `0 < 1000` ⇒ laço encerrado ⇒ ~40% do caixa devolvido como se fosse o caixa inteiro.
    // Nada distingue esse total de uma empresa que de fato movimentou menos.
    state.db.fin_movimentacoes = Array.from({ length: 2500 }, (_, i) =>
      mov(i, `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, 10),
    );
    state.dataNullNaRequisicao.fin_movimentacoes = 2;

    // Ancorado em `data=null sem error`, trecho EXCLUSIVO deste ramo: os dois guards
    // compartilham o prefixo `Falha ao carregar <contexto>`, então casar o prefixo
    // passaria verde com este ramo sabotado (lição do #1524, money-path §6).
    await expect(getFluxoCaixa('oben', INICIO, FIM)).rejects.toThrow(/data=null sem error/);
  });

  it('múltiplo exato da capa: página vazia (data:[]) é fim LEGÍTIMO, não malformação', async () => {
    // Contraparte do teste acima — o guard de `null` não pode engolir o EOF de verdade.
    // Com 2.000 linhas a 3ª requisição volta `data: []`; confundir `[]` com `null` faria
    // toda leitura de tamanho múltiplo de 1.000 lançar, quebrando a tela no caso são.
    state.db.fin_movimentacoes = Array.from({ length: 2000 }, (_, i) =>
      mov(i, `2026-${String(Math.floor(i / 200) + 1).padStart(2, '0')}-${String((i % 25) + 1).padStart(2, '0')}`, 10),
    );

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaRealizadoEntradas(fluxo)).toBe(20000);
  });

  it('ordem total: empate em data_movimento não pode pular nem duplicar entre páginas', async () => {
    // 3 dias × 900 movimentos: as fronteiras de página (1.000 e 2.000) caem DENTRO
    // de um dia — o cenário medido em prod, onde 100% das linhas empatam em data.
    // Valor distinto por linha: qualquer pulo/duplicata desloca a soma.
    const dias = ['2026-03-01', '2026-03-02', '2026-03-03'];
    state.db.fin_movimentacoes = Array.from({ length: 2700 }, (_, i) =>
      mov(i, dias[Math.floor(i / 900)], i + 1),
    );
    const esperado = (2700 * 2701) / 2;

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaRealizadoEntradas(fluxo)).toBe(esperado);
  });

  it('soma TODAS as páginas acima da capa de 1.000 do PostgREST', async () => {
    // Dias distintos isolam a paginação do desempate: aqui não há empate nenhum.
    state.db.fin_movimentacoes = Array.from({ length: 2500 }, (_, i) =>
      mov(i, `2026-${String(Math.floor(i / 250) + 1).padStart(2, '0')}-${String((i % 25) + 1).padStart(2, '0')}`, 10),
    );

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaRealizadoEntradas(fluxo)).toBe(25000);
  });
});

describe('getFluxoCaixa — caixa PREVISTO (fin_contas_receber / fin_contas_pagar)', () => {
  beforeEach(() => {
    state.db = { fin_movimentacoes: [], fin_contas_receber: [], fin_contas_pagar: [] };
    state.falharNaRequisicao = {};
    state.dataNullNaRequisicao = {};
    state.requisicoes = {};
  });

  it('erro no CR LANÇA — projeção parcial engana tanto quanto realizado parcial', async () => {
    state.db.fin_contas_receber = [titulo(0, '2026-03-01', 10)];
    state.falharNaRequisicao.fin_contas_receber = 1;

    await expect(getFluxoCaixa('oben', INICIO, FIM)).rejects.toBeInstanceOf(Error);
  });

  it('erro no CP LANÇA', async () => {
    state.db.fin_contas_pagar = [
      { ...titulo(0, '2026-03-01', 10), data_pagamento: null, valor_pago: 0 },
    ];
    state.falharNaRequisicao.fin_contas_pagar = 1;

    await expect(getFluxoCaixa('oben', INICIO, FIM)).rejects.toBeInstanceOf(Error);
  });

  it('data:null SEM error no CR LANÇA — a projeção não encerra numa página malformada', async () => {
    state.db.fin_contas_receber = [titulo(0, '2026-03-01', 10)];
    state.dataNullNaRequisicao.fin_contas_receber = 1;

    await expect(getFluxoCaixa('oben', INICIO, FIM)).rejects.toThrow(/data=null sem error/);
  });

  it('CR acima da capa de 1.000 não sai truncado (prod: 4.094 títulos na janela)', async () => {
    // 2.500 títulos A VENCER de R$10: sem paginação o PostgREST devolve 1.000 e a
    // projeção exibe R$10k onde há R$25k.
    state.db.fin_contas_receber = Array.from({ length: 2500 }, (_, i) =>
      titulo(i, `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, 10),
    );

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaPrevistoEntradas(fluxo)).toBe(25000);
  });
});
