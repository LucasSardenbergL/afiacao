import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useLastVisit } from '@/hooks/useLastVisit';
import type { DeltaSpec } from '@/lib/dashboard/delta-aggregators';
import type { Persona } from '@/lib/dashboard/persona-config';

export interface BriefDelta extends DeltaSpec {
  /** Caminho clicável que filtra pela janela de tempo do delta. */
  path: string;
  /** Identificador pra telemetria. */
  type: string;
}

/**
 * Busca contagens de eventos relevantes desde `lastVisitIso`.
 * Filtragem por persona acontece downstream (DeltasStrip pega só os relevantes).
 *
 * Implementação MVP: queries simples de count.
 * - sales_orders criados desde lastVisit
 * - nfe_recebimentos criados desde lastVisit
 * - eventos_outlier criados desde lastVisit (aumentos)
 * - orders status=orcamento_enviado desde lastVisit
 *
 * Tabelas que não existirem (em ambientes de dev) caem pra count=0 silenciosamente.
 */
export function useBriefDeltas(_persona: Persona): { deltas: BriefDelta[]; isLoading: boolean; isEmpty: boolean } {
  const { companies, mode } = useDashboardCompany();
  const { lastVisitIso } = useLastVisit();

  const enabled = !!lastVisitIso;

  const queryKey = ['dashboard', 'brief-deltas', mode, companies.join(','), lastVisitIso ?? 'none'];

  const { data, isLoading } = useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<BriefDelta[]> => {
      if (!lastVisitIso) return [];
      const since = lastVisitIso;
      const results: BriefDelta[] = [];

      // sales_orders novos
      try {
        const q = supabase
          .from('sales_orders')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since);
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'sales_new',
            label: 'pedidos',
            singular: 'pedido',
            value: count ?? 0,
            path: `/sales?createdAfter=${encodeURIComponent(since)}`,
          });
        }
      } catch { /* tabela ausente em dev */ }

      // NF-es novas
      try {
        const q = supabase
          .from('nfe_recebimentos')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since);
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'nfe_new',
            label: 'NF chegaram',
            singular: 'NF chegou',
            value: count ?? 0,
            path: `/recebimento?createdAfter=${encodeURIComponent(since)}`,
          });
        }
      } catch { /* */ }

      // Eventos outlier (aumentos)
      try {
        const q = supabase
          .from('eventos_outlier')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since);
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'aumentos_new',
            label: 'aumentos anunciados',
            singular: 'aumento anunciado',
            value: count ?? 0,
            path: `/admin/reposicao/sessao/mercado?createdAfter=${encodeURIComponent(since)}`,
          });
        }
      } catch { /* */ }

      // Orçamentos novos
      try {
        const q = supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', since)
          .eq('status', 'orcamento_enviado');
        const { count } = await q;
        if ((count ?? 0) > 0) {
          results.push({
            type: 'orcamentos_new',
            label: 'orçamentos enviados',
            singular: 'orçamento enviado',
            value: count ?? 0,
            path: `/admin?status=orcamento_enviado`,
          });
        }
      } catch { /* */ }

      return results;
    },
    staleTime: 60 * 1000,
  });

  const deltas = data ?? [];
  // Cap em 5 bullets (cap conforme spec).
  const capped = deltas.slice(0, 5);
  return { deltas: capped, isLoading: enabled && isLoading, isEmpty: capped.length === 0 };
}
