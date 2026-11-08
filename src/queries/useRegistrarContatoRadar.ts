import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { invalidarRadar } from '@/lib/radar/invalidar-cache';
import { lerDesfazer, lerRegistroContato } from '@/lib/radar/borda-rpc';
import type { AcaoContato } from '@/lib/radar/ui-helpers';

/**
 * RPC `registrar_contato_radar`: { id, deduped, notaGravada, retornoEm }. Usada pelo menu individual e pelo lote.
 * `retorno` ('YYYY-MM-DD') só no "em conversa" (pacote G1); sem ele, o servidor usa hoje+7 em dia útil.
 */
export async function registrarContatoRadar(v: { cnpj: string; acao: AcaoContato; nota?: string | null; retorno?: string | null }) {
  // `p_nota` e `p_retorno` têm DEFAULT NULL na prod: ausentes, as chaves saem do JSON e caem no mesmo NULL.
  const { data, error } = await supabase.rpc('registrar_contato_radar', {
    p_cnpj: v.cnpj,
    p_acao: v.acao,
    p_nota: v.nota ?? undefined,
    p_retorno: v.retorno ?? undefined,
  });
  if (error) throw error;
  return lerRegistroContato(data, 'registrar_contato_radar');
}

export function useRegistrarContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: registrarContatoRadar,
    onSuccess: (_d, v) => {
      track('radar.contato_registrado', { acao: v.acao, com_nota: Boolean(v.nota?.trim()), com_retorno: Boolean(v.retorno) });
      void invalidarRadar(qc);
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
    onSuccess: () => { void invalidarRadar(qc); },
  });
}
