// Hooks da aba Ciclo com o mock no nível do CLIENT supabase (não do módulo do hook):
// normalização snake_case→camelCase, descartes (ausente ≠ zero), janela TTM e erro exposto.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Resp = { data: Record<string, unknown>[] | null; error: unknown };
const tabelas: Record<string, Resp> = {};
const consultas: Array<{ tabela: string; de?: number }> = [];
const rpcs: Array<{ nome: string; args: unknown }> = [];

function builder(tabela: string) {
  const b: Record<string, unknown> = {};
  const encadeia = () => b;
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) b[m] = encadeia;
  // fetchAllPages: 1ª página = linhas da tabela; 2ª (de > 0) = [] (fim)
  b.range = (de: number) => {
    consultas.push({ tabela, de });
    return Promise.resolve(de === 0 ? tabelas[tabela] : { data: [], error: null });
  };
  // leitura sem paginação (coorte): o builder é thenable
  b.then = (ok: (r: Resp) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(tabelas[tabela]).then(ok, ko);
  return b;
}

// Ciclo lê por RPC (fin_ciclo_*): `rpc(nome, args)` devolve o mesmo builder, indexado pelo NOME da RPC.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => builder(tabela),
    rpc: (nome: string, args?: unknown) => {
      rpcs.push({ nome, args });
      return builder(nome);
    },
  },
}));

import { useCicloCoorte, useCicloGiroSku, useCicloResumo, useCicloTitulosCliente, useReceitaDiariaTtm, useReguaCiclo } from '../useFinanceiroCiclo';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, children);

const dre = (company: string, ano: number, mes: number, valor: string | null, cat = '1.01') =>
  ({ company, ano, mes, categoria_codigo: cat, valor_total: valor });

beforeEach(() => {
  for (const k of Object.keys(tabelas)) delete tabelas[k];
  consultas.length = 0;
  rpcs.length = 0;
  // 01:30 UTC de 01/11 = 31/10 22:30 em São Paulo → o mês corrente de hojeSp é OUTUBRO/2026 (não novembro)
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T01:30:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('useCicloResumo', () => {
  it('normaliza snake_case com numeric string→number, null preservado, e descarta linha sem omie_codigo_cliente', async () => {
    tabelas.fin_ciclo_cliente_resumo = {
      error: null,
      data: [
        { company: 'oben', omie_codigo_cliente: 7, nome_cliente: 'ACME', valor_pago: '1234.50', saldo_vencido: null, n_documentos: '8', prazo_real_pond: '31.25' },
        { company: 'oben', omie_codigo_cliente: null, nome_cliente: 'SEM CHAVE', valor_pago: '10' },
      ],
    };
    const { result } = renderHook(() => useCicloResumo(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    const c = result.current.data![0];
    expect(c).toMatchObject({ company: 'oben', omieCodigoCliente: 7, nomeCliente: 'ACME', valorPago: 1234.5, nDocumentos: 8, prazoRealPond: 31.25 });
    expect(c.saldoVencido).toBeNull(); // ausente ≠ zero
    expect(c.atrasoP80).toBeNull();
    expect(consultas.some((q) => q.tabela === 'fin_ciclo_cliente_resumo' && q.de === 0)).toBe(true); // paginou pela 1ª página
    expect(rpcs).toEqual([{ nome: 'fin_ciclo_cliente_resumo', args: undefined }]); // lê pela RPC, não pela view
  });

  it('erro do supabase vira `error` do hook (não lista vazia)', async () => {
    tabelas.fin_ciclo_cliente_resumo = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useCicloResumo(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeTruthy();
    expect(result.current.data).toBeUndefined();
  });
});

describe('useCicloCoorte', () => {
  it('normaliza e descarta linha com valor_vencido_no_mes null', async () => {
    tabelas.fin_ciclo_empresa_coorte = {
      error: null,
      data: [
        { company: 'oben', mes_vencimento: '2026-08-01', valor_vencido_no_mes: '1000.00', valor_pago: '900.5', valor_em_aberto: '99.5', pct_valor_pago: '0.9', prazo_concedido_pond: '30', prazo_real_pond_pagas: null, atraso_pond_pagas: null, mes_parcial: false },
        { company: 'oben', mes_vencimento: '2026-09-01', valor_vencido_no_mes: null, valor_pago: '1', valor_em_aberto: '1', mes_parcial: true },
      ],
    };
    const { result } = renderHook(() => useCicloCoorte(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{
      company: 'oben', mes: '2026-08-01', valorVencido: 1000, valorPago: 900.5, valorEmAberto: 99.5,
      pctValorPago: 0.9, prazoConcedido: 30, prazoReal: null, atraso: null, mesParcial: false,
    }]);
    expect(rpcs).toEqual([{ nome: 'fin_ciclo_empresa_coorte', args: undefined }]);
  });

  it('erro do supabase vira `error` do hook', async () => {
    tabelas.fin_ciclo_empresa_coorte = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useCicloCoorte(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useCicloTitulosCliente', () => {
  it('chama fin_ciclo_titulos_cliente com {p_company, p_cliente}, pagina e descarta título sem chave/valor/prazo', async () => {
    tabelas.fin_ciclo_titulos_cliente = {
      error: null,
      data: [
        { omie_codigo_lancamento: 101, numero_documento: 'D1', data_emissao: '2026-08-01', data_vencimento: '2026-09-01', data_baixa: '2026-09-05',
          valor_documento: '100.00', saldo: '0', situacao: 'paga', prazo_concedido_dias: '31', prazo_real_dias: '35', atraso_dias: '4', dias_vencido: null },
        { omie_codigo_lancamento: 102, valor_documento: null, prazo_concedido_dias: '30' },
      ],
    };
    const { result } = renderHook(() => useCicloTitulosCliente('oben', 7), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcs).toEqual([{ nome: 'fin_ciclo_titulos_cliente', args: { p_company: 'oben', p_cliente: 7 } }]);
    expect(consultas.some((q) => q.tabela === 'fin_ciclo_titulos_cliente' && q.de === 0)).toBe(true);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ lancamento: 101, valor: 100, prazoConcedido: 31, prazoReal: 35, atraso: 4, baixa: '2026-09-05' });
  });

  it('sem empresa/cliente selecionados não consulta', () => {
    renderHook(() => useCicloTitulosCliente(null, null), { wrapper });
    expect(rpcs).toHaveLength(0);
  });

  it('erro do supabase vira `error` do hook', async () => {
    tabelas.fin_ciclo_titulos_cliente = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useCicloTitulosCliente('colacor', 3), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useReceitaDiariaTtm', () => {
  it('TTM = Σ(12 meses cheios antes do corrente)/365: inclui o mesmo mês do ano anterior, exclui o corrente; conta meses distintos', async () => {
    tabelas.fin_dre_competencia_base = {
      error: null,
      data: [
        dre('oben', 2025, 9, '99999.00'), // fora (antes da janela)
        dre('oben', 2025, 10, '3650.00'), // dentro (borda inferior: mesmo mês do ano anterior)
        dre('oben', 2025, 10, '3650.00', '1.02'), // mesmo mês, outra categoria → soma, mas é 1 mês só
        dre('oben', 2026, 9, '3650.00'), // dentro (último mês cheio)
        dre('oben', 2026, 10, '88888.00'), // mês corrente → EXCLUÍDO
        dre('oben', 2026, 5, null), // valor ausente: não soma e não conta como mês com dado
        dre('colacor', 2026, 3, '730.00'),
        dre('colacor_sc', 2026, 10, '500.00'), // só mês corrente → fora → sem dado
      ],
    };
    const { result } = renderHook(() => useReceitaDiariaTtm(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;
    expect(d.oben.porDia).toBeCloseTo((3650 + 3650 + 3650) / 365, 10); // = 30
    expect(d.oben.mesesComDado).toBe(2); // 2025-10 e 2026-09
    expect(d.colacor).toEqual({ porDia: 2, mesesComDado: 1 });
    expect(d.colacor_sc).toEqual({ porDia: null, mesesComDado: 0 }); // sem linha na janela → null, nunca 0
  });

  it('empresa sem nenhuma linha → null / 0 meses', async () => {
    tabelas.fin_dre_competencia_base = { error: null, data: [dre('oben', 2026, 1, '365.00')] };
    const { result } = renderHook(() => useReceitaDiariaTtm(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.colacor).toEqual({ porDia: null, mesesComDado: 0 });
    expect(result.current.data!.oben).toEqual({ porDia: 1, mesesComDado: 1 });
  });

  it('erro do supabase vira `error` do hook', async () => {
    tabelas.fin_dre_competencia_base = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useReceitaDiariaTtm(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useCicloGiroSku', () => {
  it('chama fin_ciclo_giro_sku com {p_company}, pagina, normaliza e descarta linha sem código', async () => {
    tabelas.fin_ciclo_giro_sku = {
      error: null,
      data: [
        { omie_codigo_produto: 1001, codigo: 'P1001', descricao: 'TINTA', tipo_produto: '00', familia: 'TINTAS', classe: 'giro',
          divergencia_cadastro: false, saldo: '100', cmc: '10', valor_parado: '1000', consumo_qtd_365d: '365', dias_cobertura: '100.0',
          ultima_saida: '2026-10-08', dias_sem_saida: 10, valor_excedente: '100.00', acao: null, motivo_acao: null, motivo_consumo: null },
        { omie_codigo_produto: null, classe: 'giro', saldo: '1' },
      ],
    };
    const { result } = renderHook(() => useCicloGiroSku('oben'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcs).toEqual([{ nome: 'fin_ciclo_giro_sku', args: { p_company: 'oben' } }]);
    expect(consultas.some((q) => q.tabela === 'fin_ciclo_giro_sku' && q.de === 0)).toBe(true);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ omieCodigoProduto: 1001, saldo: 100, valorParado: 1000, diasCobertura: 100, motivoConsumo: null });
  });

  it('erro do supabase vira `error` do hook (nunca lista vazia)', async () => {
    tabelas.fin_ciclo_giro_sku = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useCicloGiroSku('colacor'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useReguaCiclo', () => {
  it('CMV TTM dos 12 meses fechados do DRE competência, série de estoque por dia de SP (fonte nula fora), sync e cobertura', async () => {
    // hojeSp = 2026-10-31 → 12 meses fechados = 2025-10 … 2026-09
    tabelas.fin_dre_snapshots = {
      error: null,
      data: [
        ...Array.from({ length: 12 }, (_, i) => { const idx = 2025 * 12 + 9 + i; return { company: 'oben', ano: Math.floor(idx / 12), mes: (idx % 12) + 1, cmv: '200000.00' }; }),
        { company: 'oben', ano: 2026, mes: 10, cmv: '999999.00' }, // mês corrente: fora
        { company: 'colacor', ano: 2026, mes: 9, cmv: '100.00' }, // 1/12 → sem CMV TTM
      ],
    };
    tabelas.fin_projecao_snapshots = {
      error: null,
      data: [
        { company: 'oben', snapshot_at: '2026-10-30T09:00:00Z', estoque_valor: '480000', estoque_fonte: 'omie', estoque_cobertura_ok: true },
        { company: 'oben', snapshot_at: '2026-11-01T01:00:00Z', estoque_valor: '500000', estoque_fonte: 'omie', estoque_cobertura_ok: false }, // 22:00 de 31/10 em SP
        { company: 'oben', snapshot_at: '2026-10-29T09:00:00Z', estoque_valor: null, estoque_fonte: null, estoque_cobertura_ok: null }, // sem fonte: fora
        { company: 'oben', snapshot_at: '2026-10-28T09:00:00Z', estoque_valor: '470000', estoque_fonte: 'omie', estoque_cobertura_ok: true },
        { company: 'oben', snapshot_at: '2026-10-28T20:00:00Z', estoque_valor: null, estoque_fonte: null, estoque_cobertura_ok: null }, // o ÚLTIMO do dia 28 não tem fonte → dia descoberto (não ressuscita o das 09h)
        { company: 'colacor', snapshot_at: '2026-10-30T09:00:00Z', estoque_valor: '10', estoque_fonte: 'manual', estoque_cobertura_ok: true },
      ],
    };
    tabelas.inventory_position = { error: null, data: [{ synced_at: '2026-10-31T22:30:11Z' }] };
    tabelas.fin_estoque_giro_valor = { error: null, data: [{ cobertura_pct: '97.2', skus_giro: 400, skus_giro_com_custo: 389 }] };
    const { result } = renderHook(() => useReguaCiclo(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const d = result.current.data!;
    expect(d.oben.cmvTtm).toEqual({ valor: 2400000, meses: 12, motivo: null });
    expect(d.colacor.cmvTtm.valor).toBeNull();
    expect(d.colacor.cmvTtm.motivo).toContain('1/12');
    expect(d.oben.estoqueSerie).toEqual([
      { dia: '2026-10-30', valor: 480000, coberturaOk: true },
      { dia: '2026-10-31', valor: 500000, coberturaOk: false },
    ]);
    expect(d.colacor.estoqueSerie).toEqual([{ dia: '2026-10-30', valor: 10, coberturaOk: true }]);
    expect(d.oben.estoqueSyncEm).toBe('2026-10-31T22:30:11Z');
    expect(d.oben.custoCobertura).toEqual({ pct: 97.2, skusGiro: 400, skusComCusto: 389 });
    // a RPC de giro é chamada uma vez por empresa, com a conta certa
    expect(rpcs.filter((r) => r.nome === 'fin_estoque_giro_valor').map((r) => (r.args as { p_company: string }).p_company)).toEqual(['oben', 'colacor', 'colacor_sc']);
  });

  it('erro na RPC de giro LANÇA (react-query expõe error) — nunca vira cobertura nula silenciosa', async () => {
    tabelas.fin_dre_snapshots = { error: null, data: [] };
    tabelas.fin_projecao_snapshots = { error: null, data: [] };
    tabelas.inventory_position = { error: null, data: [] };
    tabelas.fin_estoque_giro_valor = { error: { message: 'permission denied' }, data: null };
    const { result } = renderHook(() => useReguaCiclo(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error)).toContain('fin_estoque_giro_valor/oben');
  });
});
