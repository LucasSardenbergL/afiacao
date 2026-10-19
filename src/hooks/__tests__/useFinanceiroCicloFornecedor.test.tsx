// Hooks da frente 4 (fornecedores) com o mock no nível do CLIENT supabase: leitura por RPC paginada,
// normalização (ausente ≠ zero), descarte de linha sem chave e erro exposto (nunca lista vazia).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Resp = { data: Record<string, unknown>[] | null; error: unknown };
const rpcsResp: Record<string, Resp> = {};
const paginadas: string[] = [];

function builder(nome: string) {
  const b: Record<string, unknown> = {};
  const encadeia = () => b;
  for (const m of ['select', 'eq', 'order']) b[m] = encadeia;
  b.range = (de: number) => {
    paginadas.push(nome);
    return Promise.resolve(de === 0 ? rpcsResp[nome] : { data: [], error: null });
  };
  b.then = (ok: (r: Resp) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(rpcsResp[nome]).then(ok, ko);
  return b;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (nome: string) => builder(nome) },
}));

import { useCicloCpEmpresa, useCicloCpTitulos, useCicloFornecedorResumo } from '../useFinanceiroCicloFornecedor';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, children);

beforeEach(() => {
  for (const k of Object.keys(rpcsResp)) delete rpcsResp[k];
  paginadas.length = 0;
});

describe('useCicloCpTitulos', () => {
  it('lê paginado pela RPC e normaliza, preservando null', async () => {
    rpcsResp.fin_ciclo_cp_titulos = {
      error: null,
      data: [{
        company: 'oben', omie_codigo_fornecedor: 900, omie_codigo_lancamento: 1, numero_documento: 'NF1',
        data_emissao: '2026-09-01', data_vencimento: '2026-09-11', data_baixa: '2026-09-11', data_baixa_confiavel: true,
        valor_documento: '5958.04', valor_aberto: null, situacao: 'paga', prazo_concedido_dias: 10, prazo_real_dias: 10,
        dias_atraso_baixa: 0, desconto_obtido: '119.16', desconto_informado_omie: '119.16', valor_pago_principal: '5958.04',
        encargo_pago: null, dias_vencido: null,
      }],
    };
    const { result } = renderHook(() => useCicloCpTitulos(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(paginadas).toContain('fin_ciclo_cp_titulos');
    expect(result.current.data?.[0]).toMatchObject({ valor: 5958.04, descontoInformado: 119.16, encargoPago: null, situacao: 'paga' });
  });
  it('erro da RPC propaga (isError), nunca lista vazia', async () => {
    rpcsResp.fin_ciclo_cp_titulos = { data: null, error: { message: 'CICLO_SO_MASTER' } };
    const { result } = renderHook(() => useCicloCpTitulos(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useCicloFornecedorResumo', () => {
  it('descarta linha sem fornecedor e normaliza', async () => {
    rpcsResp.fin_ciclo_fornecedor_resumo = {
      error: null,
      data: [
        { company: 'oben', omie_codigo_fornecedor: 900, nome_fornecedor: 'RENNER SAYERLACK S/A', compras_12m: '2414503.11', desconto_obtido_12m: null },
        { company: 'oben', omie_codigo_fornecedor: null, compras_12m: '10' },
      ],
    };
    const { result } = renderHook(() => useCicloFornecedorResumo(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]).toMatchObject({ fornecedor: 900, compras12m: 2414503.11, descontoObtido12m: null });
  });
});

describe('useCicloCpEmpresa', () => {
  it('indexa por empresa; R$/dia null continua null', async () => {
    rpcsResp.fin_ciclo_cp_empresa = {
      error: null,
      data: [
        { company: 'oben', pmp_compras_pond: '13.07', compras_12m: '2414503.11', rs_por_dia: '6615.08', pmp_engine_controle: '12',
          n_fora_lista: 119, valor_fora_lista: '18781.15', n_sem_categoria: 0, valor_sem_categoria: '0' },
        { company: 'colacor_sc', pmp_compras_pond: null, compras_12m: null, rs_por_dia: null, pmp_engine_controle: '5',
          n_fora_lista: 26, valor_fora_lista: '35156.07', n_sem_categoria: 0, valor_sem_categoria: '0' },
      ],
    };
    const { result } = renderHook(() => useCicloCpEmpresa(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.oben).toMatchObject({ pmpComprasPond: 13.07, rsPorDia: 6615.08, pmpEngineControle: 12, nForaLista: 119 });
    expect(result.current.data?.colacor_sc?.rsPorDia).toBeNull();
    expect(result.current.data?.colacor).toBeUndefined();
  });
});
