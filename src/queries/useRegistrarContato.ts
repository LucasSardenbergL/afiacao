import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { lerDesfazer, lerRegistroComDedupe } from '@/lib/radar/borda-rpc';
import type { OutcomeStatus } from '@/lib/route/route-outcome';

// route_* não está no types.ts gerado → cast do client (mesmo padrão de useMyPositivacao).

export interface RegistrarContatoVars {
  customerUserId: string;
  status: OutcomeStatus;
  dataRota: string;            // 'yyyy-mm-dd' (a data_rota da fila)
  bucket?: string | null;
  valor?: number | null;
}

/** Registra o resultado de uma ligação via RPC (farmer server-side, dedupe). Retorna {id, deduped}. */
export function useRegistrarContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: RegistrarContatoVars): Promise<{ id: string; deduped: boolean }> => {
      // `p_bucket`/`p_valor` têm DEFAULT NULL na prod: ausente sai do JSON e cai no mesmo NULL.
      const { data, error } = await supabase.rpc('registrar_contato_rota', {
        p_customer_user_id: v.customerUserId,
        p_status: v.status,
        p_data_rota: v.dataRota,
        p_bucket: v.bucket ?? undefined,
        p_valor: v.valor ?? undefined,
      });
      if (error) throw new Error(error.message);
      // Antes, resposta ausente virava `{id: '', deduped: false}` — um registro inventado. Agora lança.
      const registro = lerRegistroComDedupe(data, 'registrar_contato_rota');
      track('rota.contato_registrado', { status: v.status });
      return registro;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route-contact-list'] }),
    // O OutcomeMenu engole a falha num catch que só mostra toast: uma RPC
    // quebrada (gate de carteira, RLS, rede) ficava invisível justo no passo
    // que ALIMENTA route_contact_log. Cobre erro do PostgREST e exceção de rede.
    onError: (e) => track('rota.contato_erro', { mensagem: mensagemDeErro(e) ?? '(sem mensagem)' }),
  });
}

/** Desfaz (deleta) o último registro próprio recente (own + <5min). Retorna {deleted}. */
export function useDesfazerContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<{ deleted: boolean }> => {
      const { data, error } = await supabase.rpc('desfazer_contato_rota', { p_id: id });
      if (error) throw new Error(error.message);
      const resultado = lerDesfazer(data, 'desfazer_contato_rota');
      track('rota.contato_desfeito', {});
      return resultado;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['route-contact-list'] }),
  });
}
