import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface RadarKpis {
  lote: string | null;
  novos: number;
  a_contatar: number;
  em_conversa: number;
  virou_cliente_mes: number;
}

/**
 * KPIs do lote do Radar (RPC `radar_kpis`).
 *
 * O `enabled` espelha o gate do SERVIDOR: a RPC faz `RAISE EXCEPTION 'forbidden:
 * gestor/master only'` quando `pode_ver_carteira_completa` é falso (= master OU employee
 * com commercial_role gerencial/estrategico/super_admin), e a rota `/radar` só exige
 * `RequireStaff` — ou seja, staff não-gestor ABRE a página e a query falha por DESENHO.
 * Sem este gate, a correção da classe "erro colapsado em vazio" transformaria essa
 * negativa de ACESSO num aviso de "não consegui ler": alarme fabricado para quem nunca
 * poderia ver o número (precisão > recall). Com `enabled:false` o estado é `desabilitada`,
 * que `naoConsegui()` exclui de propósito — a pergunta que não foi feita.
 *
 * O servidor continua sendo a autoridade (RLS + RAISE); isto é defense-in-depth de UI, e
 * o par `isMaster || isGestorComercial` é o mesmo que o TierClienteBadge já usa.
 */
export function useRadarKpis() {
  const { isMaster, isGestorComercial } = useAuth();
  const podeVer = isMaster || isGestorComercial;
  return useQuery({
    queryKey: ['radar', 'kpis'],
    enabled: podeVer,
    queryFn: async (): Promise<RadarKpis> => {
      // TODO: tipos regeneram após apply da migration da fatia 2
      const { data, error } = await (supabase.rpc as (fn: string) => ReturnType<typeof supabase.rpc>)('radar_kpis');
      if (error) throw error;
      return data as unknown as RadarKpis;
    },
    staleTime: 60_000,
  });
}
