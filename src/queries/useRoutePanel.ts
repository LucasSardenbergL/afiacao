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
// Uma função por tabela: o nome literal é o que deixa o types.ts checar as colunas do select.
function lerSnapshots(desdeISO: string): Promise<SnapshotRow[]> {
  return fetchAllPagesComMensagem(
    (de, ate) =>
      supabase
        .from('route_queue_snapshot')
        .select('data_rota, farmer_id, customer_user_id, cliente_nome, cidade, bucket, valor_da_ligacao, rank')
        .gte('data_rota', desdeISO)
        .order('data_rota', { ascending: true })
        .order('id', { ascending: true })
        .range(de, ate),
    'route_queue_snapshot/painel-rota',
    'route_queue_snapshot',
  );
}

function lerContatos(desdeISO: string): Promise<ContatoRow[]> {
  return fetchAllPagesComMensagem(
    (de, ate) =>
      supabase
        .from('route_contact_log')
        .select('data_rota, farmer_id, customer_user_id, canal, status, valor_da_ligacao, bucket')
        .gte('data_rota', desdeISO)
        .order('data_rota', { ascending: true })
        .order('id', { ascending: true })
        .range(de, ate),
    'route_contact_log/painel-rota',
    'route_contact_log',
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
        lerSnapshots(desde),
        lerContatos(desde),
      ]);
      return agregarPainel(snaps, contatos);
    },
  });
}
