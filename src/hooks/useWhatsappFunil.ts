// Funil do Canal WhatsApp (PR-3): RPC get_whatsapp_funil (INVOKER — RLS staff
// aplica; não-staff lê zeros). Atribuição por elo explícito, decidida no SQL.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { mapFunilRow, type WaFunil } from '@/lib/whatsapp/funil';

export function useWhatsappFunil(dias = 30) {
  return useQuery({
    queryKey: ['whatsapp', 'funil', dias],
    queryFn: async (): Promise<WaFunil | null> => {
      // RPC nova ainda fora do types.ts gerado — mesmo padrão de useDataHealth.ts
      const { data, error } = await supabase.rpc('get_whatsapp_funil' as never, { p_dias: dias } as never);
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? (data as unknown[])[0] : data;
      return mapFunilRow(row ?? null);
    },
  });
}
