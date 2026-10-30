import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import { podeProspectarRadar } from '@/lib/nav/acesso-radar';
import {
  lerAtendimentosAtivos, lerResultadoAtendimento, TETO_LEITURA_ATENDIMENTOS,
  type AtendimentoAtivo, type ResultadoAtendimento,
} from '@/lib/radar/atendimento';

const CHAVE = ['radar', 'atendimentos-ativos'] as const;

/**
 * "Em atendimento por X" de TODOS os leads (RPC `radar_atendimentos_ativos`, migration 20261029201200). Lista e
 * ficha leem a mesma query (o react-query deduplica). O servidor limita a 100 posses por dono, então o total fica
 * longe do corte de 1.000 do PostgREST; se ainda assim vier no teto, é ERRO, nunca "a lista acabou".
 * Fora do gate do Radar a query nem roda (`desabilitada`): negativa de acesso não vira aviso de leitura.
 */
export function useRadarAtendimentosAtivos() {
  const { role, commercialRole } = useAuth();
  return useQuery({
    queryKey: CHAVE,
    enabled: podeProspectarRadar({ role, commercialRole }),
    staleTime: 30_000,
    queryFn: async (): Promise<Map<string, AtendimentoAtivo>> => {
      const { data, error } = await supabase
        .rpc('radar_atendimentos_ativos')
        .order('cnpj', { ascending: true })
        .range(0, TETO_LEITURA_ATENDIMENTOS - 1);
      if (error) throw error;
      return lerAtendimentosAtivos(data, 'radar_atendimentos_ativos');
    },
  });
}

/** Assumir / liberar um lead — o ÚNICO escritor é a RPC `radar_definir_atendimento`. */
export function useRadarDefinirAtendimento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cnpj: string; acao: 'assumir' | 'liberar' }): Promise<ResultadoAtendimento> => {
      const { data, error } = await supabase.rpc('radar_definir_atendimento', { p_cnpj: v.cnpj, p_acao: v.acao });
      if (error) throw error;
      return lerResultadoAtendimento(data, 'radar_definir_atendimento');
    },
    onSuccess: (r, v) => {
      track(v.acao === 'assumir' ? 'radar.lead_assumido' : 'radar.lead_liberado', {
        ok: r.ok, motivo: r.ok ? null : r.motivo,
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}
