import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { hojeSP } from '@/lib/time/sp-day';

/**
 * As contagens dos badges da sidebar que eram `return count ?? 0` dentro do `AppShell`
 * (plano v8, C14 — o resíduo anotado no C11 do v7).
 *
 * Cada `queryFn` LANÇA no erro: é a pré-condição do contrato `faceDoBadge`
 * (`badge-de-contagem.ts`). Com `return count ?? 0`, uma falha deixava a query `success` com 0,
 * e o shell — que só desenha badge > 0 — fazia "não consegui contar" parecer "nada pendente".
 * `count` nulo sem erro também lança: ausente ≠ zero.
 */
function contagemOuErro(r: { count: number | null; error: unknown }, oque: string): number {
  if (r.error) throw r.error;
  if (r.count == null) throw new Error(`contagem ausente: ${oque}`);
  return r.count;
}

/** Pedidos de compra do ciclo de hoje aguardando aprovação (ou barrados por guardrail). */
export function usePedidosPendentesBadge(enabled: boolean) {
  return useQuery({
    queryKey: ['pedidos-pendentes-count'],
    queryFn: async () => {
      // data_ciclo é o dia de SP (gerar-pedidos-diario e o "recalcular"): com o dia UTC o badge zerava às 21h.
      const today = hojeSP();
      const r = await supabase
        .from('pedido_compra_sugerido')
        .select('*', { count: 'exact', head: true })
        .eq('data_ciclo', today)
        .in('status', ['pendente_aprovacao', 'bloqueado_guardrail']);
      return contagemOuErro(r, 'pedidos pendentes');
    },
    enabled,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    staleTime: 15000,
  });
}

/** Aumentos de fornecedor ativos aguardando vigência. */
export function useAumentosAtivosBadge(enabled: boolean) {
  return useQuery({
    queryKey: ['aumentos-ativos-count'],
    queryFn: async () => {
      const r = await supabase
        .from('fornecedor_aumento_anunciado')
        .select('*', { count: 'exact', head: true })
        .eq('estado', 'ativo');
      return contagemOuErro(r, 'aumentos ativos');
    },
    enabled,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
  });
}

/** Sugestões novas de negociação paralela (OBEN). */
export function useNegociacaoNovasBadge(enabled: boolean) {
  return useQuery({
    queryKey: ['negociacao-paralela-sugestoes-count'],
    queryFn: async () => {
      const r = await supabase
        .from('v_sugestao_negociacao_ativa')
        .select('*', { count: 'exact', head: true })
        .eq('empresa', 'OBEN')
        .eq('status', 'nova');
      return contagemOuErro(r, 'sugestões de negociação');
    },
    enabled,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 30000,
  });
}

/** Alertas de fornecedor pendentes de notificação. */
export function useNotificacoesPendentesBadge(enabled: boolean) {
  return useQuery({
    queryKey: ['notificacoes-pendentes-count'],
    queryFn: async () => {
      const r = await supabase
        .from('fornecedor_alerta')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pendente_notificacao');
      return contagemOuErro(r, 'notificações pendentes');
    },
    enabled,
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
    staleTime: 30000,
  });
}
