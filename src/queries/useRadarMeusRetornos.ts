import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { lerPaginaRetornos, type RetornoHoje } from '@/lib/radar/prospectar-hoje';
import { useHojeBRT } from '@/lib/radar/useHojeBRT';

const PAGINA = 50;

/**
 * Todos os retornos do vendedor vencidos até hoje, por vencimento (RPC `radar_meus_retornos`, migration
 * 20261113110100 — revisão 2026-11-11, item 8). A agenda "Hoje" mostra os 20 primeiros e dizia "+N além destes" sem
 * onde lê-los. Paginada por OFFSET de 50; só lê com a lista aberta. Na lente, os da persona vista (a RPC só aceita de
 * gestor). O dia BRT entra na chave, como na agenda.
 */
export function useRadarMeusRetornos(aberto: boolean) {
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const alvo = isImpersonating ? effectiveUserId : null;
  const hoje = useHojeBRT();
  return useInfiniteQuery({
    queryKey: ['radar', 'meus-retornos', alvo ?? 'eu', hoje],
    enabled: aberto,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<{ total: number; itens: RetornoHoje[] }> => {
      const { data, error } = await supabase.rpc('radar_meus_retornos', {
        ...(alvo ? { p_vendedor: alvo } : {}),
        p_offset: pageParam,
        p_limit: PAGINA,
      });
      if (error) throw error;
      return lerPaginaRetornos(data, 'radar_meus_retornos');
    },
    getNextPageParam: (ultima, paginas) => {
      const lidos = paginas.reduce((n, p) => n + p.itens.length, 0);
      return ultima.itens.length > 0 && lidos < ultima.total ? lidos : undefined;
    },
    staleTime: 60_000,
  });
}
