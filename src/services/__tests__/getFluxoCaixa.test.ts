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
  // As colunas PEDIDAS. O mock antigo ignorava o `.select()` e devolvia a linha inteira —
  // então um filtro sobre coluna NÃO selecionada passava verde aqui e virava `undefined` em
  // produção. No caso desta suíte isso não é hipotético: filtrar por `categoria_descricao`
  // sem incluí-la no select ZERA o fluxo realizado, e o mock antigo aprovava (11/11). Achado
  // da revisão Codex. Projetar é o que dá dente ao teste.
  let colunas: string[] | null = null;
  const projetar = (r: Row): Row => {
    if (!colunas) return r;
    const out: Row = {};
    for (const c of colunas) if (c in r) out[c] = r[c];
    return out;
  };
  const builder = {
    select: (cols: string) => {
      colunas = cols.split(',').map((c) => c.trim()).filter(Boolean);
      return builder;
    },
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
      const rows = (janela
        ? ordenadas.slice(janela.from, Math.min(janela.to + 1, janela.from + 1000))
        : ordenadas.slice(0, 1000)
      ).map(projetar);
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
const mov = (
  i: number,
  dia: string,
  valor: number,
  tipo = 'E',
  // Default = a ótica BANCÁRIA, que é a única que conta como caixa realizado. Antes as
  // fixtures não tinham categoria nenhuma, então a suíte inteira era cega para a ótica.
  categoria_descricao = tipo === 'E' ? 'CONTA_CORRENTE_REC' : 'CONTA_CORRENTE_PAG',
): Row => ({
  id: `mov-${String(i).padStart(6, '0')}`,
  company: 'oben',
  data_movimento: dia,
  tipo,
  valor,
  categoria_descricao,
  omie_codigo_lancamento: 1000 + i,
});

/**
 * Título de CR. `saldo` é COMPUTADO aqui pela MESMA regra da coluna GERADA do banco
 * (`valor_documento - COALESCE(valor_recebido, 0)`, confirmada em prod via psql-ro
 * 2026-09-09) em vez de ser um campo livre: fixture que escolhe `saldo` à mão pode
 * afirmar um estado que o Postgres nunca produz, e aí o teste prova a fixture, não a tela.
 */
const titulo = (i: number, dia: string, valor: number, recebido = 0): Row => ({
  id: `cr-${String(i).padStart(6, '0')}`,
  company: 'oben',
  data_vencimento: dia,
  data_recebimento: null,
  valor_documento: valor,
  valor_recebido: recebido,
  saldo: valor - recebido,
  status_titulo: 'A VENCER',
});

/** Título de CP — mesma regra do `saldo` gerado, com `valor_pago` no lugar de `valor_recebido`. */
const tituloPagar = (i: number, dia: string, valor: number, pago = 0): Row => ({
  id: `cp-${String(i).padStart(6, '0')}`,
  company: 'oben',
  data_vencimento: dia,
  data_pagamento: null,
  valor_documento: valor,
  valor_pago: pago,
  saldo: valor - pago,
  status_titulo: 'A VENCER',
});

const somaRealizadoEntradas = (fluxo: { entradas_realizadas: number }[]) =>
  fluxo.reduce((s, d) => s + d.entradas_realizadas, 0);
const somaPrevistoEntradas = (fluxo: { entradas_previstas: number }[]) =>
  fluxo.reduce((s, d) => s + d.entradas_previstas, 0);
const somaPrevistoSaidas = (fluxo: { saidas_previstas: number }[]) =>
  fluxo.reduce((s, d) => s + d.saidas_previstas, 0);

describe('getFluxoCaixa — caixa REALIZADO (fin_movimentacoes)', () => {
  beforeEach(() => {
    state.db = { fin_movimentacoes: [], fin_contas_receber: [], fin_contas_pagar: [] };
    state.falharNaRequisicao = {};
    state.dataNullNaRequisicao = {};
    state.requisicoes = {};
  });

  // O mock TEM de respeitar o `.select()`. Sem este caso, a projeção acrescentada acima não
  // é exercida por teste nenhum: os casos de ótica filtram na QUERY (`.in`), que enxerga a
  // linha inteira, e o helper não lê `categoria_descricao`. Medido ao falsificar — sabotar a
  // projeção deixava a suíte VERDE.
  //
  // O que ele protege é concreto: a query não seleciona `categoria_descricao`, então mover o
  // filtro de ótica para o helper faria o campo chegar `undefined`, o filtro rejeitaria tudo
  // e o caixa realizado viraria ZERO em produção — com o mock cego aprovando a mudança.
  it('o mock devolve SÓ as colunas do .select() — coluna não pedida chega undefined', async () => {
    state.db.fin_movimentacoes = [mov(1, '2026-03-10', 500, 'E')];

    const { supabase } = await import('@/integrations/supabase/client');
    const { data } = await supabase
      .from('fin_movimentacoes')
      .select('data_movimento, tipo, valor, omie_codigo_lancamento')
      .eq('company', 'oben');

    expect(data?.[0]).toBeDefined();
    expect(data![0].valor).toBe(500);
    // a coluna EXISTE na linha semeada, mas não foi pedida — não pode vazar
    expect('categoria_descricao' in data![0]).toBe(false);
  });

  // ── ÓTICA: o Omie devolve o MESMO pagamento duas vezes ───────────────────────────────
  // Estes casos não existiam, e por isso a dobra viveu em produção: as fixtures antigas não
  // tinham `categoria_descricao`, então nenhum teste podia distinguir uma ótica da outra.
  it('o MESMO pagamento nas duas óticas conta UMA vez — a bancária', async () => {
    // Um pagamento de R$ 500: o lançamento do título (dia 10) e o crédito em conta (dia 11,
    // D+1 de compensação). Somar os dois daria 1.000 e ainda espalharia caixa por 2 dias.
    state.db.fin_movimentacoes = [
      mov(1, '2026-03-10', 500, 'E', 'CONTA_A_RECEBER'),
      mov(1, '2026-03-11', 500, 'E', 'CONTA_CORRENTE_REC'),
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaRealizadoEntradas(fluxo)).toBe(500);
    expect(fluxo.find((d) => d.data === '2026-03-11')?.entradas_realizadas).toBe(500);
    expect(fluxo.find((d) => d.data === '2026-03-10')?.entradas_realizadas ?? 0).toBe(0);
  });

  it('PREVISÃO não é caixa realizado', async () => {
    // `PREVISAO_*` é tipo 'E', valor>0 e TEM título — passa por todo filtro do helper.
    // Por negação (`NOT LIKE 'CONTA_A_%'`) entraria como dinheiro que entrou. Não entrou.
    state.db.fin_movimentacoes = [
      mov(1, '2026-03-10', 700, 'E', 'PREVISAO_PEDIDO_VENDA'),
      mov(2, '2026-03-10', 300, 'E', 'PREVISAO_ORDEM_SERVICO'),
      mov(3, '2026-03-10', 100, 'E', 'CONTA_CORRENTE_REC'),
    ];

    expect(somaRealizadoEntradas(await getFluxoCaixa('oben', INICIO, FIM))).toBe(100);
  });

  it('as duas óticas do lado PAGAR também contam uma vez', async () => {
    state.db.fin_movimentacoes = [
      mov(1, '2026-03-10', 800, 'S', 'CONTA_A_PAGAR'),
      mov(1, '2026-03-10', 800, 'S', 'CONTA_CORRENTE_PAG'),
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);
    expect(fluxo.reduce((s, d) => s + d.saidas_realizadas, 0)).toBe(800);
  });

  it('baixas PARCIAIS na ótica bancária somam — não se deduplica por título', async () => {
    // Duas baixas reais do mesmo título (nCodBaixa distinto no Omie). Deduplicar por título
    // aqui perderia metade do caixa: são dois eventos bancários, não duas óticas de um.
    state.db.fin_movimentacoes = [
      { ...mov(1, '2026-03-10', 400, 'E'), id: 'mov-a' },
      { ...mov(1, '2026-03-20', 600, 'E'), id: 'mov-b' },
    ];

    expect(somaRealizadoEntradas(await getFluxoCaixa('oben', INICIO, FIM))).toBe(1000);
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
    state.db.fin_contas_pagar = [tituloPagar(0, '2026-03-01', 10)];
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

  // ── Baixa PARCIAL: a 4ª forma de a projeção mentir, e a única que mente pra CIMA ──
  // As três acima subnotificavam (página perdida, ordem instável, capa de 1.000). Esta
  // INFLA: um título parcialmente baixado segue com status ABERTO, mas a parte já
  // recebida entrou na conta e já está no `saldo_atual` de `fin_contas_correntes` — a
  // ÂNCORA da projeção. Somar `valor_documento` cheio conta esse dinheiro duas vezes.
  // Mesmo eixo (dupla contagem no tempo) da correção do saldo projetado do FluxoCaixaTab,
  // um degrau abaixo: lá era a semana, aqui é o título.

  it('CR com baixa PARCIAL entra pelo SALDO, não pelo valor cheio', async () => {
    // doc 1.000, recebido 400 ⇒ saldo 600. Os 400 já estão no saldo da conta corrente:
    // prever 1.000 os conta de novo.
    state.db.fin_contas_receber = [titulo(0, '2026-03-10', 1000, 400)];

    expect(somaPrevistoEntradas(await getFluxoCaixa('oben', INICIO, FIM))).toBe(600);
  });

  it('CP com baixa PARCIAL entra pelo SALDO, não pelo valor cheio', async () => {
    state.db.fin_contas_pagar = [tituloPagar(0, '2026-03-10', 1000, 400)];

    expect(somaPrevistoSaidas(await getFluxoCaixa('oben', INICIO, FIM))).toBe(600);
  });

  it('título SEM baixa segue pelo valor cheio — a troca não muda o caso de hoje (#396)', async () => {
    // Contrapeso do par acima: hoje `valor_recebido` é 0 em 100% do universo (o LIST do
    // Omie não traz a baixa), então saldo == valor_documento e o previsto NÃO muda. Sem
    // este caso, um bug que zerasse o previsto passaria pelos dois testes de parcial.
    state.db.fin_contas_receber = [titulo(0, '2026-03-10', 1000)];
    state.db.fin_contas_pagar = [tituloPagar(0, '2026-03-11', 700)];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaPrevistoEntradas(fluxo)).toBe(1000);
    expect(somaPrevistoSaidas(fluxo)).toBe(700);
  });

  // ── Lacunas: seis sabotagens passavam 17/17 (revisão Codex do #2458) ──────────────────
  // Cada caso abaixo nasce para deixar VERMELHA uma troca que a suíte aprovava. Os casos que
  // esperam "não entra" levam um título legítimo junto — sem ele, uma sabotagem que zerasse o
  // previsto inteiro também passaria. E CR e CP usam magnitudes diferentes: quando só um dos
  // dois laços é sabotado, a mensagem do vitest diz qual.

  it('título em aberto com saldo ZERO não ressuscita o valor cheio', async () => {
    // A regressão mais provável do #2458: `saldo || valor_documento` trata o zero legítimo
    // (baixa integral com o status ainda aberto) como ausência e volta a somar o documento.
    state.db.fin_contas_receber = [
      titulo(0, '2026-03-10', 1000, 1000),
      titulo(1, '2026-03-12', 250),
    ];
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2026-03-11', 700, 700),
      tituloPagar(1, '2026-03-13', 40),
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaPrevistoEntradas(fluxo)).toBe(250);
    expect(somaPrevistoSaidas(fluxo)).toBe(40);
  });

  it('título liquidado, cancelado, de status desconhecido ou nulo NÃO entra no previsto', async () => {
    // Não é hipotético: em prod (2026-10-08) há 20 CR RECEBIDO + 24 CANCELADO com vencimento
    // nos próximos 3 meses — R$ 35,7 mil que, sem o filtro, a tela somaria como a receber.
    // Potências de 10: se algum escapar, a soma diz qual.
    state.db.fin_contas_receber = [
      titulo(0, '2026-03-10', 1),
      { ...titulo(1, '2026-03-10', 10), status_titulo: 'RECEBIDO' },
      { ...titulo(2, '2026-03-11', 100), status_titulo: 'CANCELADO' },
      { ...titulo(3, '2026-03-11', 1000), status_titulo: 'LIQUIDADO' },
      { ...titulo(4, '2026-03-12', 10000), status_titulo: 'EM NEGOCIACAO' },
      { ...titulo(5, '2026-03-12', 100000), status_titulo: null },
    ];
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2026-03-10', 2),
      { ...tituloPagar(1, '2026-03-10', 20), status_titulo: 'PAGO' },
      { ...tituloPagar(2, '2026-03-11', 200), status_titulo: 'CANCELADO' },
      { ...tituloPagar(3, '2026-03-11', 2000), status_titulo: 'LIQUIDADO' },
      { ...tituloPagar(4, '2026-03-12', 20000), status_titulo: 'EM NEGOCIACAO' },
      { ...tituloPagar(5, '2026-03-12', 200000), status_titulo: null },
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaPrevistoEntradas(fluxo)).toBe(1);
    expect(somaPrevistoSaidas(fluxo)).toBe(2);
  });

  it("'ATRASADO' e 'VENCE HOJE' entram — aberto não é só 'A VENCER'", async () => {
    state.db.fin_contas_receber = [
      titulo(0, '2026-03-10', 100),
      { ...titulo(1, '2026-03-10', 200), status_titulo: 'ATRASADO' },
      { ...titulo(2, '2026-03-11', 400), status_titulo: 'VENCE HOJE' },
    ];
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2026-03-10', 10),
      { ...tituloPagar(1, '2026-03-10', 20), status_titulo: 'ATRASADO' },
      { ...tituloPagar(2, '2026-03-11', 40), status_titulo: 'VENCE HOJE' },
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaPrevistoEntradas(fluxo)).toBe(700);
    expect(somaPrevistoSaidas(fluxo)).toBe(70);
  });

  // ── Status AMBÍGUO nunca infla o caixa projetado — por isso a regra é assimétrica ──────
  // 'ABERTO'/'VENCIDO' são o fallback do ingest quando o Omie NÃO manda status (e 'ABERTO' é o
  // DEFAULT da coluna); 'PARCIAL' só tem remanescente confiável com a baixa gravada, que o LIST
  // não traz (#396). Na ENTRADA, contar o ambíguo pode prever dinheiro que não vem; na SAÍDA,
  // DEIXAR de contar é que infla o saldo projetado. Os três tinham zero linhas em prod
  // (2026-10-08). Valores em potências de 10: a soma diz exatamente quais entraram.

  it("ENTRADA prevista exige status NATIVO do Omie — 'ABERTO', 'VENCIDO' e 'PARCIAL' ficam fora do CR", async () => {
    // O PARCIAL aqui está como está HOJE em prod: status parcial e `valor_recebido` 0, logo
    // `saldo` = documento cheio. Contá-lo seria prever de novo a parte já recebida — que o
    // saldo âncora já tem.
    state.db.fin_contas_receber = [
      titulo(0, '2026-03-10', 1),
      { ...titulo(1, '2026-03-10', 10), status_titulo: 'ABERTO' },
      { ...titulo(2, '2026-03-11', 100), status_titulo: 'VENCIDO' },
      { ...titulo(3, '2026-03-12', 1000), status_titulo: 'PARCIAL' },
    ];

    expect(somaPrevistoEntradas(await getFluxoCaixa('oben', INICIO, FIM))).toBe(1);
  });

  it("SAÍDA prevista aceita o aberto canônico — 'ABERTO', 'VENCIDO' e 'PARCIAL' entram no CP", async () => {
    // Uma obrigação de status incerto some da projeção se ficar de fora — e o saldo projetado
    // sobe. Contá-la é o erro conservador. O PARCIAL entra pelo SALDO (doc 6.000 − pago 4.000).
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2026-03-10', 2),
      { ...tituloPagar(1, '2026-03-10', 20), status_titulo: 'ABERTO' },
      { ...tituloPagar(2, '2026-03-11', 200), status_titulo: 'VENCIDO' },
      { ...tituloPagar(3, '2026-03-12', 6000, 4000), status_titulo: 'PARCIAL' },
    ];

    expect(somaPrevistoSaidas(await getFluxoCaixa('oben', INICIO, FIM))).toBe(2222);
  });

  it('o previsto cai no DIA do vencimento, não no início da janela', async () => {
    // Somar no dia errado preserva o total — e todo teste por soma passava. Mas a tela só
    // conta como previsto os dias >= hoje: dinheiro deslocado para o início da janela (6 meses
    // atrás) SOME da projeção.
    state.db.fin_contas_receber = [titulo(0, '2026-03-10', 300)];
    state.db.fin_contas_pagar = [tituloPagar(0, '2026-03-20', 80)];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(fluxo.find((d) => d.data === '2026-03-10')?.entradas_previstas).toBe(300);
    expect(fluxo.find((d) => d.data === '2026-03-20')?.saidas_previstas).toBe(80);
  });

  it('dois títulos no MESMO dia somam, com centavos — não fica só o último', async () => {
    // Centavos em frações binárias exatas (,25 ,50 ,75): a soma em ponto flutuante é exata, e
    // qualquer arredondamento/truncamento no caminho desloca o resultado.
    state.db.fin_contas_receber = [
      titulo(0, '2026-03-10', 30.25),
      titulo(1, '2026-03-10', 50.5),
    ];
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2026-03-10', 300.5),
      tituloPagar(1, '2026-03-10', 500.25),
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);
    const dia = fluxo.find((d) => d.data === '2026-03-10');

    expect(dia?.entradas_previstas).toBe(80.75);
    expect(dia?.saidas_previstas).toBe(800.75);
  });

  it('a visão de UMA empresa não soma título nem movimento de outra; a visão "todas" soma', async () => {
    // Caixa é por CNPJ e não é fungível: título da colacor na tela da oben é dinheiro que a
    // oben não tem. As fixtures eram todas da oben, então remover o filtro passava verde.
    state.db.fin_contas_receber = [
      titulo(0, '2026-03-10', 1),
      { ...titulo(1, '2026-03-10', 10), company: 'colacor' },
    ];
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2026-03-10', 2),
      { ...tituloPagar(1, '2026-03-10', 20), company: 'colacor' },
    ];
    state.db.fin_movimentacoes = [
      mov(0, '2026-03-10', 3),
      { ...mov(1, '2026-03-10', 30), company: 'colacor' },
    ];

    const oben = await getFluxoCaixa('oben', INICIO, FIM);
    expect(somaPrevistoEntradas(oben)).toBe(1);
    expect(somaPrevistoSaidas(oben)).toBe(2);
    expect(somaRealizadoEntradas(oben)).toBe(3);

    const todas = await getFluxoCaixa('all', INICIO, FIM);
    expect(somaPrevistoEntradas(todas)).toBe(11);
    expect(somaPrevistoSaidas(todas)).toBe(22);
    expect(somaRealizadoEntradas(todas)).toBe(33);
  });

  it('a janela é inclusiva nas duas pontas e nada de fora dela entra', async () => {
    // A tela conta como previsto todo dia >= hoje que o serviço devolver: um título além do fim
    // da janela, se vazasse, entraria no total previsto. Fronteiras exatas + um dia de cada lado.
    state.db.fin_contas_receber = [
      titulo(0, '2025-12-31', 1000),
      titulo(1, INICIO, 1),
      titulo(2, FIM, 10),
      titulo(3, '2027-01-01', 100),
    ];
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2025-12-31', 2000),
      tituloPagar(1, INICIO, 2),
      tituloPagar(2, FIM, 20),
      tituloPagar(3, '2027-01-01', 200),
    ];
    state.db.fin_movimentacoes = [
      mov(0, '2025-12-31', 3000),
      mov(1, INICIO, 3),
      mov(2, FIM, 30),
      mov(3, '2027-01-01', 300),
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaPrevistoEntradas(fluxo)).toBe(11);
    expect(somaPrevistoSaidas(fluxo)).toBe(22);
    expect(somaRealizadoEntradas(fluxo)).toBe(33);
  });

  it('ordem total no previsto: acima da capa, CR e CP não pulam nem duplicam título entre páginas', async () => {
    // O teste de 2.500 CR acima usa valor IGUAL por título: pular um e duplicar outro preserva a
    // soma, e ele não vê ordem instável. Aqui cada título tem valor distinto — e o CP ganha o
    // seu teste de paginação, que não tinha.
    state.db.fin_contas_receber = Array.from({ length: 2500 }, (_, i) =>
      titulo(i, `2026-03-${String((i % 28) + 1).padStart(2, '0')}`, i + 1),
    );
    state.db.fin_contas_pagar = Array.from({ length: 2500 }, (_, i) =>
      tituloPagar(i, `2026-04-${String((i % 28) + 1).padStart(2, '0')}`, 2 * (i + 1)),
    );

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(somaPrevistoEntradas(fluxo)).toBe((2500 * 2501) / 2);
    expect(somaPrevistoSaidas(fluxo)).toBe(2500 * 2501);
  });

  it('saldo NEGATIVO (baixa maior que o documento) não vira caixa fantasma — o título conta zero', async () => {
    // Juros/multa na baixa, ou status defasado: `saldo < 0` num título ainda aberto. Cru, ele
    // entra como ENTRADA NEGATIVA no CR e, no CP, como saída negativa — que SOBE o acumulado.
    // O dia mistura um título normal com o negativo de propósito: o zero é POR TÍTULO. Com o
    // corte aplicado à soma do dia, o negativo comeria a entrada do vizinho (700, não 1.000).
    state.db.fin_contas_receber = [
      titulo(0, '2026-03-10', 1000),
      titulo(1, '2026-03-10', 500, 800),
    ];
    state.db.fin_contas_pagar = [
      tituloPagar(0, '2026-03-11', 600),
      tituloPagar(1, '2026-03-11', 200, 450),
    ];

    const fluxo = await getFluxoCaixa('oben', INICIO, FIM);

    expect(fluxo.find((d) => d.data === '2026-03-10')?.entradas_previstas).toBe(1000);
    expect(fluxo.find((d) => d.data === '2026-03-11')?.saidas_previstas).toBe(600);
  });
});
