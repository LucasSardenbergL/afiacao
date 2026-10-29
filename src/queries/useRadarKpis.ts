import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { podeProspectarRadar } from '@/lib/radar/acesso';

export interface RadarKpis {
  lote: string | null;
  novos: number;
  a_contatar: number;
  em_conversa: number;
  virou_cliente_mes: number;
}

/**
 * O jsonb de `radar_kpis` (`jsonb_build_object` de 5 chaves na prod) lido por forma: contagem que
 * não é número LANÇA — o card mostra "não consegui ler", nunca um 0 fabricado.
 */
function kpisDoJson(v: Json): RadarKpis {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('radar_kpis: resposta não é objeto');
  const { lote, novos, a_contatar, em_conversa, virou_cliente_mes } = v;
  if (
    !(lote === null || typeof lote === 'string') ||
    typeof novos !== 'number' ||
    typeof a_contatar !== 'number' ||
    typeof em_conversa !== 'number' ||
    typeof virou_cliente_mes !== 'number'
  ) {
    throw new Error('radar_kpis: resposta fora da forma {lote, novos, a_contatar, em_conversa, virou_cliente_mes}');
  }
  return { lote, novos, a_contatar, em_conversa, virou_cliente_mes };
}

/**
 * KPIs do lote do Radar (RPC `radar_kpis`).
 *
 * O `enabled` espelha o gate do SERVIDOR: a RPC faz `RAISE EXCEPTION 'forbidden: radar_prospectar'` quando
 * `private.cap_radar_prospectar` é falso (= master, gestor comercial ou vendedor farmer/hunter/closer; migration
 * 20261029201200), e a rota `/radar` só exige `RequireStaff` — staff fora do gate (operacional, sem cargo) ABRE
 * a página e a query falharia por DESENHO. Sem este gate, a correção da classe "erro colapsado em vazio"
 * transformaria essa negativa de ACESSO num aviso de "não consegui ler": alarme fabricado para quem nunca
 * poderia ver o número (precisão > recall). Com `enabled:false` o estado é `desabilitada`, que `naoConsegui()`
 * exclui de propósito — a pergunta que não foi feita.
 *
 * O servidor continua sendo a autoridade (RLS + RAISE); isto é defense-in-depth de UI, com o usuário REAL
 * (`useAuth`): a RPC roda com o JWT dele, não com o da persona da lente.
 */
export function useRadarKpis() {
  const { role, commercialRole } = useAuth();
  const podeVer = podeProspectarRadar({ role, commercialRole });
  return useQuery({
    queryKey: ['radar', 'kpis'],
    enabled: podeVer,
    queryFn: async (): Promise<RadarKpis> => {
      const { data, error } = await supabase.rpc('radar_kpis');
      if (error) throw error;
      return kpisDoJson(data);
    },
    staleTime: 60_000,
  });
}
