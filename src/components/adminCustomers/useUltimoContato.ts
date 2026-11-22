import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { subDays } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import {
  JANELA_ULTIMO_CONTATO_DIAS, ultimoPorCliente, type EstadoUltimoContato, type RegistroContato,
} from './ultimoContato';

const TAMANHO_LOTE = 200;

function lotes<T>(xs: T[], n: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < xs.length; i += n) saida.push(xs.slice(i, i + n));
  return saida;
}

/**
 * Último contato dos clientes VISÍVEIS na lista — uma leitura em lote (nunca uma por linha), nas duas
 * fontes de desfecho. RLS: `venda_contato` só abre para o dono ou master (a vendedora vê os PRÓPRIOS
 * registros); `route_contact_log` abre para todo staff. Qualquer página que falhe LANÇA → a lista diz
 * "indisponível", nunca "sem contato".
 */
export function useUltimoContato(ids: string[]): { porCliente: Map<string, RegistroContato>; estado: EstadoUltimoContato } {
  const chave = [...ids].sort().join(',');
  const q = useQuery({
    queryKey: ['ultimo-contato-clientes', chave],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<RegistroContato[]> => {
      const corte = subDays(new Date(), JANELA_ULTIMO_CONTATO_DIAS).toISOString();
      const porLote = await Promise.all(lotes(ids, TAMANHO_LOTE).map(async (lote) => {
        const [fichas, rotas] = await Promise.all([
          fetchAllPagesComMensagem<{ comprador_id: string; resultado: string | null; atualizado_em: string }>(
            (de, ate) => supabase.from('venda_contato')
              .select('comprador_id, resultado, atualizado_em')
              .in('comprador_id', lote)
              .gte('atualizado_em', corte)
              .order('id', { ascending: true })
              .range(de, ate),
            'venda_contato/ultimo-contato', 'venda_contato'),
          fetchAllPagesComMensagem<{ customer_user_id: string; status: string | null; created_at: string }>(
            (de, ate) => supabase.from('route_contact_log')
              .select('customer_user_id, status, created_at')
              .in('customer_user_id', lote)
              .gte('created_at', corte)
              .order('id', { ascending: true })
              .range(de, ate),
            'route_contact_log/ultimo-contato', 'route_contact_log'),
        ]);
        return [
          ...fichas.map((f) => ({ clienteId: f.comprador_id, em: f.atualizado_em, desfecho: f.resultado })),
          ...rotas.map((r) => ({ clienteId: r.customer_user_id, em: r.created_at, desfecho: r.status })),
        ];
      }));
      return porLote.flat();
    },
  });
  const estado: EstadoUltimoContato = ids.length === 0 || q.data ? 'ok' : q.isError ? 'falha' : 'carregando';
  const porCliente = useMemo(() => ultimoPorCliente(q.data ?? []), [q.data]);
  return { porCliente, estado };
}
