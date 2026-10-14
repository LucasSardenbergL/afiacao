// src/queries/useRoutePanel.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import { spBusinessDate } from '@/lib/time/sp-day';
import { agregarPainel } from '@/lib/route/painel/agregar';
import type { SnapshotRow, ContatoRow, PainelAgregado } from '@/lib/route/painel/types';

// Pagina pelo canônico: página com error ou `data: null` sem error LANÇA (o painel somaria o valor
// da ligação sobre um PREFIXO da janela) e a página perdida é medida pela fonte. `data_rota` não é
// único → desempate por `id` (PK nas duas tabelas), senão o offset pula/duplica na fronteira.
function lerTudo<T>(tabela: string, cols: string, desdeISO: string): Promise<T[]> {
  return fetchAllPagesComMensagem<T>(
    (de, ate) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase.from(tabela as never) as any)
        .select(cols)
        .gte('data_rota', desdeISO)
        .order('data_rota', { ascending: true })
        .order('id', { ascending: true })
        .range(de, ate),
    `${tabela}/painel-rota`,
    tabela,
  );
}

/** dias = janela (default 30) terminando hoje (SP). */
export function useRoutePanel(dias = 30) {
  return useQuery({
    queryKey: ['route-panel', dias],
    staleTime: 60_000,
    queryFn: async (): Promise<PainelAgregado> => {
      const hoje = spBusinessDate(new Date());
      const d = new Date(hoje + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - (dias - 1));
      const desde = spBusinessDate(d);
      const [snaps, contatos] = await Promise.all([
        lerTudo<SnapshotRow>('route_queue_snapshot', 'data_rota, farmer_id, customer_user_id, cliente_nome, cidade, bucket, valor_da_ligacao, rank', desde),
        lerTudo<ContatoRow>('route_contact_log', 'data_rota, farmer_id, customer_user_id, canal, status, valor_da_ligacao, bucket', desde),
      ]);
      return agregarPainel(snaps, contatos);
    },
  });
}
