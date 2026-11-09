import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import { podeGerirRadar, podeProspectarRadar } from '@/lib/nav/acesso-radar';
import {
  lerAtendimentosAtivos, lerResultadoAtendimento, lerResultadoAtribuicao, lerVendedoresAtribuiveis,
  TETO_LEITURA_ATENDIMENTOS,
  type AtendimentoAtivo, type ResultadoAtendimento, type ResultadoAtribuicao, type VendedorAtribuivel,
} from '@/lib/radar/atendimento';

const CHAVE = ['radar', 'atendimentos-ativos'] as const;
/** Card "Prospectar hoje" (useRadarProspectarHoje): assumir/liberar/atribuir muda quem entra nele (pacote F, achado 3 —
 *  antes só a posse era relida, e o card seguia oferecendo "Assumir" para o lead que acabou de ser assumido). */
const CHAVE_CARD = ['radar', 'prospectar-hoje'] as const;
/** Posse mudou → relê a posse E o card (prefixo: todas as personas da lente). */
function reler(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([qc.invalidateQueries({ queryKey: CHAVE }), qc.invalidateQueries({ queryKey: CHAVE_CARD })]);
}

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
    onSettled: () => reler(qc),
  });
}

/**
 * Quem pode receber um lead (RPC `radar_vendedores_atribuiveis`, migration 20261106221000). Só gestor/master lê;
 * a query só roda quando o seletor abre (`aberto`) e com o usuário REAL podendo gerir o Radar.
 */
export function useRadarVendedoresAtribuiveis(aberto: boolean) {
  const { role, commercialRole } = useAuth();
  return useQuery({
    queryKey: ['radar', 'vendedores-atribuiveis'] as const,
    enabled: aberto && podeGerirRadar({ role, commercialRole }),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<VendedorAtribuivel[]> => {
      const { data, error } = await supabase
        .rpc('radar_vendedores_atribuiveis')
        .order('nome', { ascending: true, nullsFirst: false })
        .order('user_id', { ascending: true })
        .range(0, TETO_LEITURA_ATENDIMENTOS - 1);
      if (error) throw error;
      return lerVendedoresAtribuiveis(data, 'radar_vendedores_atribuiveis');
    },
  });
}

/** Gestor/master passa o lead a um vendedor — escritor: RPC `radar_atribuir_atendimento` (gate de gestor no banco). */
export function useRadarAtribuirAtendimento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cnpj: string; donoUserId: string }): Promise<ResultadoAtribuicao> => {
      const { data, error } = await supabase.rpc('radar_atribuir_atendimento', { p_cnpj: v.cnpj, p_dono: v.donoUserId });
      if (error) throw error;
      return lerResultadoAtribuicao(data, 'radar_atribuir_atendimento');
    },
    onSuccess: (r) => {
      track('radar.lead_atribuido', {
        ok: r.ok, motivo: r.ok ? null : r.motivo, tirou_de_outro: r.ok ? r.tirouDeOutro : null,
      });
    },
    onSettled: () => reler(qc),
  });
}
