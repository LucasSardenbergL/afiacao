import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { subDays } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import { coletarEmLotesConcorrente, CONCORRENCIA_LOTES, hashIds } from '@/lib/lotes';
import {
  JANELA_ULTIMO_CONTATO_DIAS, ultimoPorCliente, type ContextoUltimoContato, type EstadoUltimoContato,
  type RegistroContato,
} from './ultimoContato';

const TAMANHO_LOTE = 200;

type ConsultaDeLote = (lote: string[]) => Promise<RegistroContato[]>;

/** Um sub-lote de ≤200 ids (limite de URL do `.in`), nas DUAS fontes. Página com erro LANÇA. */
const lerSubLote: ConsultaDeLote = async (lote) => {
  const corte = subDays(new Date(), JANELA_ULTIMO_CONTATO_DIAS).toISOString();
  const [fichas, rotas] = await Promise.all([
    fetchAllPagesComMensagem<{ comprador_id: string; resultado: string | null; atualizado_em: string }>(
      (de, ate) => supabase.from('venda_contato')
        .select('comprador_id, resultado, atualizado_em')
        .in('comprador_id', lote)
        .gte('atualizado_em', corte)
        .order('id', { ascending: true })
        .range(de, ate),
      'venda_contato/ultimo-contato', 'venda_contato'),
    fetchAllPagesComMensagem<{ customer_user_id: string | null; status: string | null; created_at: string }>(
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
    ...rotas.flatMap((r) => (r.customer_user_id
      ? [{ clienteId: r.customer_user_id, em: r.created_at, desfecho: r.status }]
      : [])),
  ];
};

/**
 * Último contato da lista — leitura em lote (nunca uma por linha), nas duas fontes de desfecho. RLS:
 * `venda_contato` só abre para o dono ou master (a vendedora vê os PRÓPRIOS registros);
 * `route_contact_log` abre para todo staff. Qualquer página que falhe LANÇA → "indisponível", nunca
 * "sem contato".
 *
 * Onda E: recebe os lotes ESTÁVEIS do escopo (`lotesIds`: uma página do servidor na base completa; a
 * carteira inteira, A–Z, num lote), UMA query por lote. Antes a key era a lista FILTRADA ordenada:
 * cada termo da busca (e cada filtro de saúde) trocava a key e relia ~15 lotes × 2 tabelas; e cada
 * "carregar mais" relia as páginas já lidas. Agora busca/filtro não releem nada, e a página nova lê só
 * a si mesma. O estado é POR LOTE (`estadoDe`): a página que ainda carrega não apaga as já lidas.
 *
 * Onda B: `contexto` muda o que a AUSÊNCIA significa. `escopoSemRegistro` só com TODOS os lotes lidos
 * e zero registros (lote em falha/carregando não é "vazio"); `soOsProprios` = não-master, porque a RLS
 * de `venda_contato` esconde o contato feito por outra pessoa (usuário REAL — é o que o banco vê).
 */
export function useUltimoContato(lotesIds: string[][]): {
  porCliente: Map<string, RegistroContato>;
  estado: EstadoUltimoContato;
  estadoDe: (clienteId: string) => EstadoUltimoContato;
  contexto: ContextoUltimoContato;
} {
  const { isMaster } = useAuth();
  // Hash (contagem + ids, mesma key dos scores) — não a string de ~2.8k UUIDs, re-serializada a cada render.
  const chaves = useMemo(() => lotesIds.map(hashIds), [lotesIds]);
  const qs = useQueries({
    queries: lotesIds.map((ids, i) => ({
      queryKey: ['ultimo-contato-clientes', chaves[i]],
      enabled: ids.length > 0,
      staleTime: 60_000,
      queryFn: () => coletarEmLotesConcorrente(ids, TAMANHO_LOTE, CONCORRENCIA_LOTES, lerSubLote),
    })),
  });
  const estadoDoLote = (i: number): EstadoUltimoContato =>
    qs[i]?.data ? 'ok' : qs[i]?.isError ? 'falha' : 'carregando';
  const versao = qs.map((q, i) => `${chaves[i]}:${q.dataUpdatedAt}:${q.isError ? 1 : 0}`).join('|');
  const { porCliente, loteDe, estados, total } = useMemo(() => {
    const loteDe = new Map<string, number>();
    lotesIds.forEach((ids, i) => { for (const id of ids) loteDe.set(id, i); });
    const registros = qs.flatMap((q) => q.data ?? []);
    return {
      porCliente: ultimoPorCliente(registros), loteDe, estados: lotesIds.map((_, i) => estadoDoLote(i)),
      total: registros.length,
    };
    // `useQueries` devolve array novo a cada render: a versão (lotes + leitura de cada um) é a dep real.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lotesIds, versao]);
  const estado: EstadoUltimoContato = estados.every((e) => e === 'ok')
    ? 'ok' : estados.includes('falha') ? 'falha' : 'carregando';
  // Id fora de qualquer lote (não deveria acontecer): 'carregando' — nunca 'ok', que diria "sem contato".
  const estadoDe = (clienteId: string): EstadoUltimoContato => {
    const i = loteDe.get(clienteId);
    return i === undefined ? 'carregando' : estados[i];
  };
  const contexto: ContextoUltimoContato = {
    escopoSemRegistro: lotesIds.length > 0 && estado === 'ok' && total === 0,
    soOsProprios: !isMaster,
  };
  return { porCliente, estado, estadoDe, contexto };
}
