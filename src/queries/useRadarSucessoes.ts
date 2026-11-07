import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  lerPreviaSucessao, lerResultadoEscritaSucessao, lerSucessoesDoDocumento,
  type PreviaSucessao, type ResultadoEscritaSucessao, type SucessoesDoDocumento, type TipoSucessao,
} from '@/lib/radar/sucessao';

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
