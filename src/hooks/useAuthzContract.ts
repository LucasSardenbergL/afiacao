import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * 🔐 Versão do contrato de autorização vigente NO BANCO (E2/FU4 — spec 2026-07-18).
 *
 * v1 = gate único `pode_ver_carteira_completa` (uma função concedendo 64 policies em 34 tabelas,
 *      incluindo escrita em preço/crédito e leitura de custo).
 * v2 = matriz de capability por recurso × ação (`private.cap_*`), onde o papel gerencial
 *      operacional NÃO herda mais preço, crédito, custo nem compras.
 *
 * POR QUE ISTO É UMA CONSULTA AO BANCO, e não uma constante no código:
 * no Lovable, merge na `main` ≠ produção — a migration de nome custom NÃO é aplicada
 * automaticamente e falha em SILÊNCIO. Se o frontend fosse uma constante `true`, um Publish sem
 * a migration aplicada reabriria o furo sem nenhum sinal: o app concederia o papel gerencial
 * enquanto o banco ainda estivesse com as policies v1. Perguntando ao banco, o pior caso é
 * conservador — sem a migration, a RPC não existe, a consulta falha e o papel segue bloqueado.
 *
 * FAIL-CLOSED por construção: erro, RPC ausente (404) ou carregando ⇒ v1 ⇒ capability negada.
 */
export const AUTHZ_CONTRATO_MATRIZ = 2;

interface UseAuthzContractReturn {
  /** Versão lida do banco. 1 quando indeterminada — nunca otimista. */
  version: number;
  /** true só quando o banco confirma a matriz de capability aplicada. */
  matrizAtiva: boolean;
  loading: boolean;
}

export function useAuthzContract(): UseAuthzContractReturn {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['authz-contract-version'],
    queryFn: async (): Promise<number> => {
      // `as never`: a RPC entra nos tipos gerados só na próxima regeneração pós-migration.
      const { data, error } = await supabase.rpc('authz_contract_version' as never);
      if (error) throw error;
      return typeof data === 'number' ? data : AUTHZ_CONTRATO_MATRIZ - 1;
    },
    // O contrato só muda por migration — não vale re-perguntar a cada foco de janela.
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: 1,
  });

  const version = data ?? AUTHZ_CONTRATO_MATRIZ - 1;

  return {
    version,
    // ⚠️ `!isError` não é redundante (furo apanhado na revisão adversária do Codex): o
    // react-query PRESERVA o último `data` bem-sucedido quando um refetch falha. Sem esta
    // cláusula, uma sessão que leu v2 e depois perdeu a RPC — migration revertida, rollback,
    // queda de rede — continuaria concedendo capability gerencial com base num cache obsoleto.
    // Fail-closed de verdade é: qualquer sinal de erro corrente ⇒ capability negada.
    matrizAtiva: !isError && version >= AUTHZ_CONTRATO_MATRIZ,
    loading: isLoading,
  };
}
