import { useQuery, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { loteVigente, type LoteIngest } from '@/lib/radar/lote-vigente';

/**
 * Lote VIGENTE do Radar — UMA query compartilhada (`['radar','lote-vigente']`).
 *
 * Lista, KPIs, linha e ficha leem o MESMO valor: os componentes via `useRadarLoteVigente()`,
 * a lista (que precisa do lote DENTRO do `queryFn`) via `lerLoteVigente(queryClient)` — mesma
 * chave, mesmo cache, mesmo `staleTime`; a leitura acontece uma vez, não por componente.
 *
 * `null` = não há lote `complete` (tabela vazia ou só running/error). É "não sei qual é a
 * foto", nunca "zero inéditos": o card mostra "sem dado" e a fila roda sem o filtro de lote
 * (espelha o `v_lote IS NULL OR ultimo_lote = v_lote` da RPC `radar_kpis`).
 *
 * `radar_ingest_state` tem RLS de leitura só para gestor (`cap_carteira_ler`); para quem não
 * é, o SELECT devolve 0 linhas (não erro) — e `radar_empresas` tem a mesma policy, então a
 * fila já era vazia para essa pessoa. Nada muda para ela.
 */
const LOTE_VIGENTE_KEY = ['radar', 'lote-vigente'] as const;

async function buscarLoteVigente(): Promise<LoteIngest | null> {
  const { data, error } = await supabase
    .from('radar_ingest_state')
    .select('mes_referencia,status,total_recebido,novos,iniciado_em')
    .order('mes_referencia', { ascending: false })
    .limit(36); // 3 anos de lotes mensais — a tabela tem um punhado de linhas
  if (error) throw error;
  return loteVigente((data ?? []) as LoteIngest[]);
}

const opcoes = () => ({ queryKey: LOTE_VIGENTE_KEY, queryFn: buscarLoteVigente, staleTime: 60_000 });

export function useRadarLoteVigente() {
  return useQuery(opcoes());
}

/** Para `queryFn` de outras queries (a lista): lê do cache se fresco, senão busca — e PROPAGA
 *  o erro, para a query que depende do lote errar junto em vez de rodar sem ele. */
export function lerLoteVigente(qc: QueryClient): Promise<LoteIngest | null> {
  return qc.fetchQuery(opcoes());
}
