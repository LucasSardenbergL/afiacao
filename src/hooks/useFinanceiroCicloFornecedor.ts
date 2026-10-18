// Leituras da frente 4 da aba "Ciclo" (fornecedores, master-only): fatos de v_ciclo_cp_titulos /
// v_ciclo_fornecedor_resumo / fin_ciclo_cp_empresa por RPC SECURITY DEFINER com gate master. Regra no helper puro.
// Erro de leitura LANÇA (react-query expõe `error`) — nunca vira lista vazia.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { num } from '@/lib/financeiro/ciclo-cliente-helpers';
import {
  normalizarResumoFornecedor, normalizarTituloCp, type ResumoFornecedor, type TituloCp,
} from '@/lib/financeiro/ciclo-fornecedor-helpers';
import type { Company } from '@/contexts/CompanyContext';

type Linha = Record<string, unknown>;
// As 3 RPCs nascem nesta migration e ainda não estão no types.ts gerado: builder mínimo tipado à mão.
type BuilderRpc = {
  select: (c: string) => BuilderRpc;
  order: (c: string, o: { ascending: boolean }) => BuilderRpc;
  range: (de: number, ate: number) => PromiseLike<{ data: Linha[] | null; error: unknown }>;
};
const rpcSemTipo = (nome: string) => (supabase as unknown as { rpc: (n: string) => BuilderRpc }).rpc(nome);

/** .rpc() set-returning também é capado em 1.000 linhas pelo PostgREST → paginar sempre, com ordem estável. */
/** Ordem estável: `company` + a chave única da linha (`segunda`), ou só `company` (1 linha por empresa). */
function lerRpc(nome: 'fin_ciclo_cp_titulos' | 'fin_ciclo_fornecedor_resumo' | 'fin_ciclo_cp_empresa', segunda: string | null) {
  return fetchAllPages<Linha>((de, ate) => {
    const q = rpcSemTipo(nome).select('*').order('company', { ascending: true });
    return (segunda === null ? q : q.order(segunda, { ascending: true })).range(de, ate);
  }, nome);
}

export function useCicloCpTitulos() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'cp-titulos'],
    queryFn: async (): Promise<TituloCp[]> => {
      const linhas = await lerRpc('fin_ciclo_cp_titulos', 'omie_codigo_lancamento');
      return linhas
        .filter((l) => num(l.omie_codigo_fornecedor) !== null && num(l.omie_codigo_lancamento) !== null)
        .map(normalizarTituloCp);
    },
  });
}

export function useCicloFornecedorResumo() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'fornecedor-resumo'],
    queryFn: async (): Promise<ResumoFornecedor[]> => {
      const linhas = await lerRpc('fin_ciclo_fornecedor_resumo', 'omie_codigo_fornecedor');
      // Sem omie_codigo_fornecedor não há fornecedor: descarta (evita a chave -1 do normalizador).
      return linhas.filter((l) => num(l.omie_codigo_fornecedor) !== null).map(normalizarResumoFornecedor);
    },
  });
}

export type CpEmpresa = {
  pmpComprasPond: number | null; compras12m: number | null; rsPorDia: number | null; pmpEngineControle: number | null;
  nForaLista: number | null; valorForaLista: number | null; nSemCategoria: number | null; valorSemCategoria: number | null;
};

export function useCicloCpEmpresa() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'cp-empresa'],
    queryFn: async (): Promise<Partial<Record<Company, CpEmpresa>>> => {
      const linhas = await lerRpc('fin_ciclo_cp_empresa', null);
      const out: Partial<Record<Company, CpEmpresa>> = {};
      for (const r of linhas) {
        out[r.company as Company] = {
          pmpComprasPond: num(r.pmp_compras_pond), compras12m: num(r.compras_12m), rsPorDia: num(r.rs_por_dia),
          pmpEngineControle: num(r.pmp_engine_controle), nForaLista: num(r.n_fora_lista),
          valorForaLista: num(r.valor_fora_lista), nSemCategoria: num(r.n_sem_categoria),
          valorSemCategoria: num(r.valor_sem_categoria),
        };
      }
      return out;
    },
  });
}
