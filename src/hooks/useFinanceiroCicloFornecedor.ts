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
import { filaCiclo, retryDelayCiclo } from '@/lib/financeiro/ciclo-fila';

/**
 * .rpc() set-returning também é capado em 1.000 linhas pelo PostgREST → paginar sempre, com ordem estável:
 * `company` + a chave única da linha, ou só `company` (fin_ciclo_cp_empresa: 1 linha por empresa).
 */
const lerCpTitulos = () =>
  fetchAllPages((de, ate) =>
    supabase.rpc('fin_ciclo_cp_titulos').select('*')
      .order('company', { ascending: true }).order('omie_codigo_lancamento', { ascending: true })
      .range(de, ate), 'fin_ciclo_cp_titulos');

const lerFornecedorResumo = () =>
  fetchAllPages((de, ate) =>
    supabase.rpc('fin_ciclo_fornecedor_resumo').select('*')
      .order('company', { ascending: true }).order('omie_codigo_fornecedor', { ascending: true })
      .range(de, ate), 'fin_ciclo_fornecedor_resumo');

const lerCpEmpresa = () =>
  fetchAllPages((de, ate) =>
    supabase.rpc('fin_ciclo_cp_empresa').select('*').order('company', { ascending: true }).range(de, ate),
    'fin_ciclo_cp_empresa');

export function useCicloCpTitulos() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'cp-titulos'],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<TituloCp[]> => filaCiclo(async () => {
      const linhas = await lerCpTitulos();
      return linhas
        .filter((l) => num(l.omie_codigo_fornecedor) !== null && num(l.omie_codigo_lancamento) !== null)
        .map(normalizarTituloCp);
    }),
  });
}

export function useCicloFornecedorResumo() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'fornecedor-resumo'],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<ResumoFornecedor[]> => filaCiclo(async () => {
      const linhas = await lerFornecedorResumo();
      // Sem omie_codigo_fornecedor não há fornecedor: descarta (evita a chave -1 do normalizador).
      return linhas.filter((l) => num(l.omie_codigo_fornecedor) !== null).map(normalizarResumoFornecedor);
    }),
  });
}

export type CpEmpresa = {
  pmpComprasPond: number | null; compras12m: number | null; rsPorDia: number | null; pmpEngineControle: number | null;
  nForaLista: number | null; valorForaLista: number | null; nSemCategoria: number | null; valorSemCategoria: number | null;
};

export function useCicloCpEmpresa() {
  return useQuery({
    queryKey: ['financeiro', 'ciclo', 'cp-empresa'],
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<Partial<Record<Company, CpEmpresa>>> => filaCiclo(async () => {
      const linhas = await lerCpEmpresa();
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
    }),
  });
}
