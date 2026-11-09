import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { podeProspectarRadar } from '@/lib/nav/acesso-radar';

export interface RadarKpis {
  lote: string | null;
  novos: number;
  /** null = o agregado do lote vigente ainda não foi calculado (hora seguinte à carga): indisponível, não 0. */
  a_contatar: number | null;
  em_conversa: number;
  virou_cliente_mes: number;
  /** Hora do cálculo do agregado de onde `a_contatar` sai; null junto com ele (ou na RPC anterior). */
  contagens_em: string | null;
}

/**
 * O jsonb de `radar_kpis` lido por forma: contagem que não é número LANÇA — o card mostra "não consegui
 * ler", nunca um 0 fabricado. A ÚNICA ausência aceita é `a_contatar: null`, que a RPC devolve quando o
 * agregado (`radar_agregado_municipio`, migration 20261103100000) não é do lote vigente; aí `contagens_em`
 * também é null. A RPC anterior não manda `contagens_em` (undefined → null).
 */
function kpisDoJson(v: Json): RadarKpis {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('radar_kpis: resposta não é objeto');
  const { lote, novos, a_contatar, em_conversa, virou_cliente_mes, contagens_em } = v;
  if (
    !(lote === null || typeof lote === 'string') ||
    typeof novos !== 'number' ||
    !(a_contatar === null || typeof a_contatar === 'number') ||
    typeof em_conversa !== 'number' ||
    typeof virou_cliente_mes !== 'number' ||
    !(contagens_em === undefined || contagens_em === null || typeof contagens_em === 'string')
  ) {
    throw new Error('radar_kpis: resposta fora da forma {lote, novos, a_contatar, em_conversa, virou_cliente_mes, contagens_em}');
  }
  return { lote, novos, a_contatar, em_conversa, virou_cliente_mes, contagens_em: contagens_em ?? null };
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
