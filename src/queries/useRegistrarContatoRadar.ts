import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { AcaoContato } from '@/lib/radar/ui-helpers';

type RpcFn = typeof supabase.rpc;

export function useRegistrarContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cnpj: string; acao: AcaoContato; nota?: string | null }) => {
      // TODO: tipos regeneram após apply da migration da fatia 2
      const { data, error } = await (supabase.rpc as RpcFn)(
        'registrar_contato_radar' as never,
        { p_cnpj: v.cnpj, p_acao: v.acao, p_nota: v.nota ?? null } as never,
      );
      if (error) throw error;
      return data as unknown as { id: string; deduped: boolean };
    },
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
      // TODO: tipos regeneram após apply da migration da fatia 2
      const { data, error } = await (supabase.rpc as RpcFn)(
        'desfazer_contato_radar' as never,
        { p_id: id } as never,
      );
      if (error) throw error;
      return data as unknown as { deleted: boolean };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['radar'] }),
  });
}
