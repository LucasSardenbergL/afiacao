import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spBusinessDate } from '@/lib/time/sp-day';
import { OPEN_TITLE_STATUSES } from '@/lib/financeiro/titulo-status';

// Saldo de extrato de HOJE em SP: conta sem `saldo_data` fresco é indisponível (plano v3, item 2).
const HOJE_SP = spBusinessDate(new Date());

/**
 * Teste de contrato do getResumoFinanceiro (resumo do FinanceiroDashboard /
 * Cockpit). Irmão do bug do KPI de /financeiro/gestao (#719): as somas de CR/CP
 * aberto+vencido eram reduce client-side SEM paginação → o PostgREST capa em
 * 1000 linhas e `total_a_receber`/`total_vencido_*` saíam truncados (oben tem
 * ~11k títulos de CR aberto).
 *
 * O mock abaixo reproduz o comportamento REAL do PostgREST: query sem .range()
 * devolve no máximo 1000 linhas; com .range(from, to) devolve a janela. Os
 * títulos do seed têm valor_documento/valor_recebido/valor_pago/saldo coerentes
 * (saldo é coluna gerada = documento − recebido/pago), então estes testes só
 * falham por truncamento/filtro errado — não por forma de coluna.
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
    limit: (_n: number) => builder,
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
      // com range a janela devolvida nunca passa de 1000 linhas (um `.range(0,
      // 99999)` NÃO fura o cap; só paginação de verdade soma tudo).
      const rows = janela
        ? matched.slice(janela.from, Math.min(janela.to + 1, janela.from + 1000))
        : matched.slice(0, 1000);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

// Fake da RPC `fin_saldo_titulos_por_status` com a semântica da migration (provada no PG17 por
// db/test-fin-saldo-titulos-por-status.sh): empresa sem título em NENHUM status → `desconhecida`;
// grupos (tabela, empresa, status) só dos status pedidos, saldo como string decimal.
const rpcCalls: Array<{ fn: string; args: { p_companies: string[]; p_statuses: string[] } }> = [];
let rpcRejeita: Error | null = null;
let rpcEnvelope: unknown;
function fakeRpc(fn: string, args: { p_companies: string[]; p_statuses: string[] }) {
  rpcCalls.push({ fn, args });
  if (rpcRejeita) return Promise.reject(rpcRejeita);
  if (rpcEnvelope !== undefined) return Promise.resolve({ data: rpcEnvelope, error: null });
  const error = state.errors.rpc;
  if (error) return Promise.resolve({ data: null, error });
  const tabelas = [['receber', 'fin_contas_receber'], ['pagar', 'fin_contas_pagar']] as const;
  const empresas = [...new Set(args.p_companies)].sort().map((company) => ({
    company,
    estado: tabelas.some(([, t]) => (state.db[t] ?? []).some((r) => r.company === company)) ? 'ok' : 'desconhecida',
  }));
  const ok = new Set(empresas.filter((e) => e.estado === 'ok').map((e) => e.company));
  const grupos: Row[] = [];
  for (const [tabela, t] of tabelas) {
    const acc = new Map<string, { company: string; status: string; n: number; centavos: number }>();
    for (const r of state.db[t] ?? []) {
      const company = r.company as string, status = r.status_titulo as string;
      if (!ok.has(company) || !args.p_statuses.includes(status)) continue;
      const k = `${company}|${status}`;
      const g = acc.get(k) ?? { company, status, n: 0, centavos: 0 };
      g.n += 1; g.centavos += Math.round((r.saldo as number) * 100);
      acc.set(k, g);
    }
    for (const g of acc.values()) {
      grupos.push({ tabela, company: g.company, status_titulo: g.status, n_titulos: g.n, n_saldo_nulo: 0, saldo: (g.centavos / 100).toFixed(2) });
    }
  }
  return Promise.resolve({ data: { versao: 1, empresas, grupos }, error: null });
}

const fromCalls: string[] = [];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => {
      fromCalls.push(tabela);
      return makeBuilder(tabela);
    },
    rpc: fakeRpc,
  },
}));

import { getResumoFinanceiro, getLastSyncTime } from '@/services/financeiroService';

const titulo = (company: string, status: string, saldo: number): Row => ({
  company,
  status_titulo: status,
  saldo,
  valor_documento: saldo,
  valor_recebido: 0,
  valor_pago: 0,
});

const muitos = (n: number, company: string, status: string, saldo: number): Row[] =>
  Array.from({ length: n }, () => titulo(company, status, saldo));

describe('getResumoFinanceiro (contrato do resumo do dashboard)', () => {
  beforeEach(() => {
    // Um título liquidado: a empresa EXISTE para a RPC (senão `desconhecida`) sem mexer nos abertos.
    state.db = { fin_contas_correntes: [], fin_contas_receber: [titulo('oben', 'RECEBIDO', 1)], fin_contas_pagar: [] };
    state.errors = {};
    rpcCalls.length = 0;
    rpcRejeita = null;
    rpcEnvelope = undefined;
  });

  it('soma os títulos pela RPC: 1 chamada para todas as empresas, com o conjunto aberto canônico', async () => {
    state.db.fin_contas_receber.push(titulo('colacor', 'A VENCER', 3));
    await getResumoFinanceiro(['oben', 'colacor']);
    expect(rpcCalls).toEqual([{
      fn: 'fin_saldo_titulos_por_status',
      args: { p_companies: ['oben', 'colacor'], p_statuses: [...OPEN_TITLE_STATUSES] },
    }]);
  });

  // Títulos têm disponibilidade PRÓPRIA (follow-up do lote 13): a empresa sem títulos sai com os
  // totais null + motivo — nunca R$ 0 — e NÃO derruba o saldo CC nem os títulos das outras.
  const contaFresca = (company: string, saldo: number): Row =>
    ({ company, ativo: true, descricao: `CC ${company}`, banco: '001', saldo_atual: saldo, saldo_data: HOJE_SP });
  const SEM_TITULOS = {
    total_a_receber: null, total_a_pagar: null, total_vencido_receber: null, total_vencido_pagar: null, posicao_liquida: null,
  };

  it('empresa desconhecida para a RPC: títulos null + motivo SÓ dela; CC e títulos das outras preservados', async () => {
    state.db.fin_contas_correntes = [contaFresca('oben', 1000), contaFresca('colacor', 1000)];
    state.db.fin_contas_receber.push(titulo('oben', 'A VENCER', 7));
    const resumo = await getResumoFinanceiro(['oben', 'colacor']);
    expect(resumo.colacor).toMatchObject({
      ...SEM_TITULOS, titulos_motivo: 'saldo de títulos indisponível (colacor): desconhecida', saldo_total_cc: 1000,
    });
    expect(resumo.colacor.contas_correntes).toHaveLength(1);
    // Dado AUSENTE, não falha de leitura: tentar de novo não muda nada (o cockpit não faz retry).
    expect(resumo.colacor.titulos_falha_leitura).toBeUndefined();
    expect(resumo.oben).toMatchObject({ total_a_receber: 7, posicao_liquida: 7, titulos_motivo: null, saldo_total_cc: 1000 });
  });

  it('erro da RPC: títulos null em todas com a mensagem do banco; o CC lido certo continua', async () => {
    state.db.fin_contas_correntes = [contaFresca('oben', 1000)];
    state.errors.rpc = { message: 'canceling statement due to statement timeout' };
    const resumo = await getResumoFinanceiro(['oben']);
    expect(resumo.oben).toMatchObject({
      ...SEM_TITULOS,
      titulos_motivo: 'Falha ao carregar saldo de títulos: canceling statement due to statement timeout',
      titulos_falha_leitura: true,
      saldo_total_cc: 1000,
    });
  });

  it('soma TODOS os títulos abertos mesmo acima do cap de 1000 do PostgREST (CR e CP)', async () => {
    state.db.fin_contas_receber = muitos(1500, 'oben', 'A VENCER', 10);
    state.db.fin_contas_pagar = muitos(1200, 'oben', 'A VENCER', 5);

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.total_a_receber).toBe(1500 * 10);
    expect(resumo.oben.total_a_pagar).toBe(1200 * 5);
    expect(resumo.oben.posicao_liquida).toBe(1500 * 10 - 1200 * 5);
  });

  it('soma TODOS os vencidos (ATRASADO) mesmo acima do cap de 1000', async () => {
    state.db.fin_contas_receber = [
      ...muitos(1100, 'oben', 'ATRASADO', 2),
      ...muitos(50, 'oben', 'A VENCER', 3),
    ];
    state.db.fin_contas_pagar = muitos(1050, 'oben', 'ATRASADO', 4);

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.total_vencido_receber).toBe(1100 * 2);
    expect(resumo.oben.total_vencido_pagar).toBe(1050 * 4);
    // ATRASADO também é aberto → compõe o total a receber junto com A VENCER
    expect(resumo.oben.total_a_receber).toBe(1100 * 2 + 50 * 3);
  });

  it('ignora liquidados/cancelados (saldo bogus do #396) e títulos de outra empresa', async () => {
    state.db.fin_contas_receber = [
      titulo('oben', 'A VENCER', 10),
      titulo('oben', 'VENCE HOJE', 7),
      titulo('oben', 'RECEBIDO', 99), // liquidado: saldo cheio por causa do #396 — fora
      titulo('oben', 'CANCELADO', 50),
      titulo('colacor', 'A VENCER', 77), // outra empresa — fora
    ];
    state.db.fin_contas_pagar = [
      titulo('oben', 'ATRASADO', 6),
      titulo('oben', 'PAGO', 88),
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.total_a_receber).toBe(10 + 7);
    expect(resumo.oben.total_a_pagar).toBe(6);
    expect(resumo.oben.total_vencido_receber).toBe(0);
    expect(resumo.oben.total_vencido_pagar).toBe(6);
  });

  it('contas correntes: soma só as ativas da empresa e normaliza campos null', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Itaú', saldo_atual: 100, saldo_data: HOJE_SP, banco: '341' },
      { company: 'oben', ativo: true, descricao: null, saldo_atual: 20, saldo_data: HOJE_SP, banco: null },
      { company: 'oben', ativo: false, descricao: 'Encerrada', saldo_atual: 999, banco: '237' },
      { company: 'colacor', ativo: true, descricao: 'Outra', saldo_atual: 55, saldo_data: HOJE_SP, banco: '001' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.saldo_total_cc).toBe(120);
    expect(resumo.oben.contas_correntes).toEqual([
      { descricao: 'Itaú', saldo_atual: 100, saldo_motivo: null, banco: '341' },
      { descricao: '', saldo_atual: 20, saldo_motivo: null, banco: '' },
    ]);
  });

  // A lista por conta segue a régua do total: o `saldo_atual ?? 0` exibia a conta sem extrato
  // como "R$ 0,00" (e a Visão Geral a escondia entre as "zeradas") e a velha com o valor antigo.
  it('lista por conta: sem saldo do extrato, DEFAULT 0 sem data e saldo velho → saldo_atual null + motivo', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Itaú', saldo_atual: 100, saldo_data: HOJE_SP, banco: '341' },
      { company: 'oben', ativo: true, descricao: 'Bradesco', saldo_atual: null, saldo_data: HOJE_SP, banco: '237' },
      { company: 'oben', ativo: true, descricao: 'Nova', saldo_atual: 0, saldo_data: null, banco: '260' },
      { company: 'oben', ativo: true, descricao: 'Parada', saldo_atual: 900, saldo_data: '2026-01-02', banco: '033' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.contas_correntes).toEqual([
      { descricao: 'Itaú', saldo_atual: 100, saldo_motivo: null, banco: '341' },
      { descricao: 'Bradesco', saldo_atual: null, saldo_motivo: 'Sem saldo do extrato', banco: '237' },
      { descricao: 'Nova', saldo_atual: null, saldo_motivo: 'Sem saldo do extrato', banco: '260' },
      { descricao: 'Parada', saldo_atual: null, saldo_motivo: 'Saldo de 02/01/2026: o extrato não atualizou', banco: '033' },
    ]);
  });

  it('lista por conta: saldo FRESCO igual a zero continua 0 (fato medido)', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Zerada', saldo_atual: 0, saldo_data: HOJE_SP, banco: '341' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.contas_correntes).toEqual([
      { descricao: 'Zerada', saldo_atual: 0, saldo_motivo: null, banco: '341' },
    ]);
  });

  // Ausente ≠ zero. Estes dois casos eram um `0` cada — o mesmo `0` das contas que somam
  // zero de verdade —, e desciam para a divisão de cobertura de caixa (alerta crítico falso)
  // e para a âncora da projeção de fluxo.
  it('conta ativa com saldo DESCONHECIDO torna o total indisponível, não menor', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Itaú', saldo_atual: 100, saldo_data: HOJE_SP, banco: '341' },
      { company: 'oben', ativo: true, descricao: 'Bradesco', saldo_atual: null, saldo_data: HOJE_SP, banco: '237' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    // Somar 100 seria apresentar um total INCOMPLETO com cara de completo.
    expect(resumo.oben.saldo_total_cc).toBeNull();
    // A listagem por conta continua como está — quem some é o TOTAL, que é o que decide.
    expect(resumo.oben.contas_correntes).toHaveLength(2);
  });

  it('nenhuma conta ativa → total indisponível (lista vazia sem erro não prova caixa zero)', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: false, descricao: 'Encerrada', saldo_atual: 999, banco: '237' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.saldo_total_cc).toBeNull();
  });

  it('conta com saldo VELHO (extrato que não atualizou) → saldo_total_cc null, não a soma com cara de hoje', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Itaú', saldo_atual: 100, saldo_data: HOJE_SP, banco: '341' },
      { company: 'oben', ativo: true, descricao: 'Bradesco', saldo_atual: 900, saldo_data: '2026-01-02', banco: '237' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.saldo_total_cc).toBeNull();
  });

  it('conta sem saldo_data (DEFAULT 0 de conta cujo 1º extrato falhou) → saldo_total_cc null', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Itaú', saldo_atual: 100, saldo_data: HOJE_SP, banco: '341' },
      { company: 'oben', ativo: true, descricao: 'Nova', saldo_atual: 0, saldo_data: null, banco: '260' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.saldo_total_cc).toBeNull();
  });

  it('contas que somam ZERO de verdade continuam sendo zero — fato medido, não ausência', async () => {
    state.db.fin_contas_correntes = [
      { company: 'oben', ativo: true, descricao: 'Itaú', saldo_atual: 500, saldo_data: HOJE_SP, banco: '341' },
      { company: 'oben', ativo: true, descricao: 'Bradesco', saldo_atual: -500, saldo_data: HOJE_SP, banco: '237' },
    ];

    const resumo = await getResumoFinanceiro(['oben']);

    expect(resumo.oben.saldo_total_cc).toBe(0);
  });

  it('RPC que REJEITA (rede) também vira títulos indisponíveis com motivo legível, não "[object Object]"', async () => {
    state.db.fin_contas_correntes = [contaFresca('oben', 1000)];
    rpcRejeita = new Error('Failed to fetch');
    const resumo = await getResumoFinanceiro(['oben']);
    expect(resumo.oben).toMatchObject({
      ...SEM_TITULOS, titulos_motivo: 'Falha ao carregar saldo de títulos: Failed to fetch', titulos_falha_leitura: true,
      saldo_total_cc: 1000,
    });
  });

  it('envelope fora do contrato: títulos indisponíveis em todas (fail-closed), nunca R$ 0', async () => {
    rpcEnvelope = [];
    const resumo = await getResumoFinanceiro(['oben']);
    expect(resumo.oben).toMatchObject({ ...SEM_TITULOS, titulos_motivo: 'resposta da RPC fora do envelope versão 1' });
  });

  it('erro nas contas correntes também LANÇA — caixa R$0 falso é tão ruim quanto total truncado', async () => {
    state.errors.fin_contas_correntes = { message: 'tabela indisponível' };
    await expect(getResumoFinanceiro(['oben'])).rejects.toBeInstanceOf(Error);
  });
});

describe('getLastSyncTime — erro de leitura LANÇA (não vira "último sync" parcial/null)', () => {
  beforeEach(() => {
    state.db = {};
    state.errors = {};
  });

  it('erro numa das tabelas lança, mesmo com as outras respondendo', async () => {
    state.db.fin_contas_receber = [{ updated_at: '2026-10-01T10:00:00Z' }];
    state.errors.fin_movimentacoes = { message: 'movimentacoes off' };
    await expect(getLastSyncTime()).rejects.toThrow(/movimentacoes off/);
  });

  it('sem erro devolve o updated_at mais recente entre as tabelas', async () => {
    state.db.fin_contas_receber = [{ updated_at: '2026-10-01T10:00:00Z' }];
    state.db.fin_contas_pagar = [{ updated_at: '2026-10-02T10:00:00Z' }];
    await expect(getLastSyncTime()).resolves.toBe('2026-10-02T10:00:00Z');
  });

  it('as 3 leituras saem juntas — a latência é a da mais lenta, não a soma', async () => {
    // CP e movimentações não têm índice no carimbo (HOT do sync): cada top-1 é seq scan + RLS por
    // linha. Em série, o resumo do useFinanceiro esperava a soma das três.
    fromCalls.length = 0;
    const pendente = getLastSyncTime();
    expect(fromCalls).toEqual(['fin_contas_receber', 'fin_contas_pagar', 'fin_movimentacoes']);
    await pendente;
  });
});
