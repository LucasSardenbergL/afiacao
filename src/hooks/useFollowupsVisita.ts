import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { hojeISO } from '@/lib/visitas/today';
import {
  montarFollowups,
  type FollowupItem,
  type VisitaFollowupRow,
} from '@/lib/visitas/followups';

const JANELA_DIAS = 45; // janela mais larga (reagendar); o helper aplica a por-resultado

export interface FollowupsVisita {
  items: FollowupItem[];
  nomePorCliente: Map<string, string>;
}

/**
 * Follow-ups sugeridos do vendedor logado: visitas mornas (route_visits, visited_by=eu)
 * sem retorno agendado nem contato posterior. RLS own-scoped (#340) — degradação honesta.
 * As 3 queries são own-scoped; agenda/ligações são auxiliares de de-dup (vazio não derruba o card).
 * Read-only.
 */
export function useFollowupsVisita() {
  const { user } = useAuth();
  const uid = user?.id;
  return useQuery({
    queryKey: ['followups-visita', uid],
    enabled: !!uid,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async (): Promise<FollowupsVisita> => {
      if (!uid) return { items: [], nomePorCliente: new Map() };
      const hoje = hojeISO();
      const desdeData = new Date(Date.now() - JANELA_DIAS * 86_400_000).toISOString().slice(0, 10);
      const desdeISO = new Date(Date.now() - JANELA_DIAS * 86_400_000).toISOString();

      const [visRes, agRes, callRes] = await Promise.all([
        supabase
          .from('route_visits')
          .select('customer_user_id, result, notes, check_in_at, visit_date, revenue_generated')
          .eq('visited_by', uid)
          .gte('visit_date', desdeData),
        supabase
          .from('visitas_agendadas')
          .select('customer_user_id')
          .eq('scheduled_by', uid)
          .eq('status', 'pendente')
          .gte('scheduled_date', hoje),
        supabase
          .from('farmer_calls')
          .select('customer_user_id, started_at')
          .eq('farmer_id', uid)
          .gte('started_at', desdeISO),
      ]);
      if (visRes.error) throw new Error(visRes.error.message);
      const visitas = (visRes.data ?? []) as VisitaFollowupRow[];

      const agendadasPendentes = new Set<string>(
        (agRes.data ?? []).map((a) => a.customer_user_id).filter((x): x is string => !!x),
      );

      const ultimoContatoPorCliente = new Map<string, string>();
      for (const c of callRes.data ?? []) {
        if (!c.customer_user_id || !c.started_at) continue;
        const cur = ultimoContatoPorCliente.get(c.customer_user_id);
        if (!cur || c.started_at > cur) ultimoContatoPorCliente.set(c.customer_user_id, c.started_at);
      }

      const items = montarFollowups({ visitas, agendadasPendentes, ultimoContatoPorCliente, hojeISO: hoje });

      // Enriquece nome só dos clientes que sobraram.
      const ids = [...new Set(items.map((i) => i.customerUserId))];
      const nomePorCliente = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('user_id, name')
          .in('user_id', ids);
        for (const p of profs ?? []) nomePorCliente.set(p.user_id, p.name);
      }

      return { items, nomePorCliente };
    },
  });
}
