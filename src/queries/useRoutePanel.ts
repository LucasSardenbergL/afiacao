// src/queries/useRoutePanel.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { spBusinessDate } from '@/lib/time/sp-day';
import { agregarPainel } from '@/lib/route/painel/agregar';
import type { SnapshotRow, ContatoRow, PainelAgregado } from '@/lib/route/painel/types';

const PAGE = 1000;

async function lerTudo<T>(tabela: string, cols: string, desdeISO: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from(tabela as never) as any)
      .select(cols).gte('data_rota', desdeISO)
      .order('data_rota', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    // data null SEM error = malformada, não fim (classe #1338→#1564): tratá-la como fim
    // deixava o painel (valor da ligação) somado sobre um PREFIXO da janela.
    if (data == null) throw new Error(`${tabela}: data null sem error — malformada, não é fim`);
    const arr = data as T[];
    out.push(...arr);
    if (arr.length < PAGE) break;
  }
  return out;
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
