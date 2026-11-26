// Contador do menu "Fila de crédito" (crédito-IA PR 6a): solicitações EFETIVAS abertas.
// Vive na plataforma (shell) e não em src/lib/credito/ — o AppShell não importa módulo de negócio
// (gate de fronteiras). RLS: só gestor/master conta. Erro → undefined (o badge some, não vira 0).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// View nova ainda fora do types.ts gerado.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function useContagemFilaCredito(enabled: boolean) {
  return useQuery({
    queryKey: ['credito', 'fila', 'contagem'],
    enabled,
    queryFn: async (): Promise<number> => {
      const { count, error } = await db
        .from('credito_fila_v')
        .select('item_id', { count: 'exact', head: true })
        .eq('origem', 'efetivo')
        .eq('status', 'aberta');
      if (error) throw error;
      if (typeof count !== 'number') throw new Error('contagem da fila não veio');
      return count;
    },
    refetchInterval: 60_000,
  });
}
