// Ordenação da fila de geocoding progressivo (Sub-PR 4, ponto G). PURO/testável.
// O worker no useRoutePlanner consome o head a cada ciclo (~1/s) e re-deriva a fila,
// então marcar um alvo no meio do caminho re-prioriza o PRÓXIMO pick (fila contínua).
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

export interface EstadoFila {
  resolvidos: Set<string>; // ids já com coord (cache em memória)
  falhados: Set<string>; // ids que falharam nesta sessão (não re-tentar → loop termina)
  marcados: Set<string>; // ids selecionados pra rota (prioridade 1)
}

/** Stops que ainda faltam geocodificar, na ordem de processamento: marcados-na-rota
 *  primeiro, depois a ordem da lista (que já vem por prioridade da RPC). Estável. */
export function ordenarFilaGeocode(stops: RouteStop[], estado: EstadoFila): RouteStop[] {
  const pendentes = stops.filter(
    (s) =>
      !!s.address.street &&
      s.lat == null &&
      !s.geocodeFailed && // falha persistida (DB) — não re-tentar entre sessões
      !estado.resolvidos.has(s.id) &&
      !estado.falhados.has(s.id),
  );
  return pendentes
    .map((s, i) => ({ s, i, prio: estado.marcados.has(s.id) ? 0 : 1 }))
    .sort((a, b) => a.prio - b.prio || a.i - b.i)
    .map((x) => x.s);
}
