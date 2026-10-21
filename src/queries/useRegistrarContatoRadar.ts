import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { lerDesfazer, lerRegistroComDedupe } from '@/lib/radar/borda-rpc';
import type { AcaoContato } from '@/lib/radar/ui-helpers';

/** RPC `registrar_contato_radar`: { id, deduped }. Usada pelo menu individual e pelo lote. */
export async function registrarContatoRadar(v: { cnpj: string; acao: AcaoContato; nota?: string | null }) {
  // `p_nota` tem DEFAULT NULL na prod: sem nota, a chave sai do JSON e cai no mesmo NULL.
  const { data, error } = await supabase.rpc('registrar_contato_radar', {
    p_cnpj: v.cnpj,
    p_acao: v.acao,
    p_nota: v.nota ?? undefined,
  });
  if (error) throw error;
  return lerRegistroComDedupe(data, 'registrar_contato_radar');
}

export function useRegistrarContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: registrarContatoRadar,
    onSuccess: (_d, v) => {
      track('radar.contato_registrado', { acao: v.acao });
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}

export function useDesfazerContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('desfazer_contato_radar', { p_id: id });
      if (error) throw error;
      return lerDesfazer(data, 'desfazer_contato_radar');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['radar'] }),
  });
}
