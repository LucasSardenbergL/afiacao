import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  lerPreviaSucessao, lerResultadoEscritaSucessao, lerSucessoesDoDocumento,
  type PreviaSucessao, type ResultadoEscritaSucessao, type SucessoesDoDocumento, type TipoSucessao,
} from '@/lib/radar/sucessao';
import {
  lerItensDoPlano, lerPlanoDoEvento, lerResultadoPlano, regrasDoRascunho,
  type ItensDoPlano, type PlanoDoEvento, type ResultadoPlano,
} from '@/lib/radar/sucessao-plano';
import { track } from '@/lib/analytics';

/**
 * Sucessão/cisão DECLARADA (migration 20261107013000). Leitura do selo com o Radar; escrita e prévia só gestor/master
 * (a fronteira é o gate das RPCs — aqui só se esconde o que o servidor recusaria). Toda escrita invalida a leitura
 * dos DOIS documentos (o selo aparece na ficha do novo e na do antigo).
 */
const CHAVE = ['radar', 'sucessoes'] as const;

export function useRadarSucessoes(documento: string | null) {
  return useQuery({
    queryKey: [...CHAVE, documento],
    enabled: !!documento,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<SucessoesDoDocumento> => {
      const { data, error } = await supabase.rpc('cliente_sucessoes_do_documento', { p_documento: documento as string });
      if (error) throw error;
      return lerSucessoesDoDocumento(data);
    },
  });
}

export function useRadarPreviaSucessao(v: { antigo: string; novo: string; dataCorte: string } | null) {
  return useQuery({
    queryKey: [...CHAVE, 'previa', v?.antigo, v?.novo, v?.dataCorte],
    enabled: !!v,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<PreviaSucessao> => {
      const { data, error } = await supabase.rpc('cliente_sucessao_previa', {
        p_antigo_documento: v!.antigo, p_novo_documento: v!.novo, p_data_corte: v!.dataCorte,
      });
      if (error) throw error;
      return lerPreviaSucessao(data);
    },
  });
}

export interface DeclararSucessao {
  antigo: string;
  novo: string;
  tipo: TipoSucessao;
  dataCorte: string;
  dataCorteSugerida: string | null;
  observacao: string | null;
  versao: number;
}

export function useRadarDeclararSucessao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: DeclararSucessao): Promise<ResultadoEscritaSucessao> => {
      const { data, error } = await supabase.rpc('cliente_declarar_sucessao', {
        p_antigo_documento: v.antigo, p_novo_documento: v.novo, p_tipo: v.tipo, p_data_corte: v.dataCorte,
        p_versao_esperada: v.versao, p_observacao: v.observacao ?? undefined,
        p_data_corte_sugerida: v.dataCorteSugerida ?? undefined,
      });
      if (error) throw error;
      return lerResultadoEscritaSucessao(data, 'cliente_declarar_sucessao');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

export function useRadarRevogarSucessao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; motivo: string; versao: number }): Promise<ResultadoEscritaSucessao> => {
      const { data, error } = await supabase.rpc('cliente_revogar_sucessao', {
        p_id: v.id, p_motivo: v.motivo, p_versao_esperada: v.versao,
      });
      if (error) throw error;
      return lerResultadoEscritaSucessao(data, 'cliente_revogar_sucessao');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

// ── Plano de rateio (entrega 3, PR C) ─────────────────────────────────────────────────────────────────────────
// Leitura e escrita gestor/master (a fronteira é o gate das RPCs). A escrita só ENFILEIRA o reprocesso das sugestões
// de hoje (cron, até 1 min): aqui não se promete efeito imediato na lista do vendedor.

const CHAVE_PLANO = ['radar', 'sucessao-plano'] as const;

export function useRadarPlanoSucessao(eventoId: string | null) {
  const plano = useQuery({
    queryKey: [...CHAVE_PLANO, 'vigente', eventoId],
    enabled: !!eventoId,
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<PlanoDoEvento> => {
      const { data, error } = await supabase.rpc('cliente_sucessao_plano_do_evento', { p_evento_id: eventoId as string });
      if (error) throw error;
      return lerPlanoDoEvento(data);
    },
  });
  const itens = useQuery({
    queryKey: [...CHAVE_PLANO, 'itens', eventoId],
    enabled: !!eventoId,
    staleTime: 30_000,
    retry: 1,
    queryFn: async (): Promise<ItensDoPlano> => {
      const { data, error } = await supabase.rpc('cliente_sucessao_plano_itens', { p_evento_id: eventoId as string });
      if (error) throw error;
      return lerItensDoPlano(data);
    },
  });
  return { plano, itens };
}

export function useRadarPublicarPlano() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      eventoId: string; revisao: number; regras: ReturnType<typeof regrasDoRascunho>; motivo: string | null;
    }): Promise<ResultadoPlano> => {
      const { data, error } = await supabase.rpc('cliente_sucessao_plano_publicar', {
        p_evento_id: v.eventoId, p_revisao_esperada: v.revisao, p_regras: v.regras, p_motivo: v.motivo ?? undefined,
      });
      if (error) throw error;
      return lerResultadoPlano(data, 'cliente_sucessao_plano_publicar');
    },
    onSuccess: (r, v) => {
      track(r.ok ? 'radar.sucessao_plano_publicado' : 'radar.sucessao_plano_recusado', {
        acao: 'publicar', regras: v.regras.length, revisao: r.ok ? r.revisao : r.revisao, motivo: r.ok ? null : r.motivo,
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE_PLANO }),
  });
}

export function useRadarRevogarPlano() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { eventoId: string; revisao: number; motivo: string }): Promise<ResultadoPlano> => {
      const { data, error } = await supabase.rpc('cliente_sucessao_plano_revogar', {
        p_evento_id: v.eventoId, p_revisao_esperada: v.revisao, p_motivo: v.motivo,
      });
      if (error) throw error;
      return lerResultadoPlano(data, 'cliente_sucessao_plano_revogar');
    },
    onSuccess: (r) => {
      track(r.ok ? 'radar.sucessao_plano_revogado' : 'radar.sucessao_plano_recusado', {
        acao: 'revogar', revisao: r.revisao, motivo: r.ok ? null : r.motivo,
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE_PLANO }),
  });
}
