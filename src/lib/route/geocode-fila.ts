// Ordenação da fila de geocoding progressivo (Sub-PR 4, ponto G). PURO/testável.
// O worker no useRoutePlanner consome o head a cada ciclo (~1/s) e re-deriva a fila,
// então marcar um alvo no meio do caminho re-prioriza o PRÓXIMO pick (fila contínua).
import type { RouteStop } from '@/components/rota/planner/types';
import { normalizarCep } from './cep';
import { precisaoVisual } from './marker-visual';

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

// --- Fila por CEP DISTINTO (Sub-PR 2 geocoding por CEP) ---------------------
// O contexto campo geocodifica o CEP, não a empresa: 1234 alvos da cidade viram
// ~574 CEPs. O worker consome o head (~1/s), faz cep_geo_upsert e pinta TODOS os
// alvos daquele CEP de uma vez. `marcados` é por stop id; o CEP herda a prioridade
// se QUALQUER alvo dele está marcado pra rota.
export interface EstadoFilaCep {
  resolvidos: Set<string>; // CEPs (8 díg) já geocodificados nesta sessão
  falhados: Set<string>; // CEPs que falharam nesta sessão (não re-tentar → loop termina)
  marcados: Set<string>; // stop ids selecionados pra rota (prioridade 1)
}

export interface CepPendente {
  cep: string; // 8 dígitos normalizado (chave do cep_geo)
  cidade: string; // do 1º alvo do CEP — alimenta a query do Nominatim
  uf: string;
}

/** CEPs DISTINTOS ainda aproximados (city_centroid/null), na ordem de processamento:
 *  CEPs com algum alvo marcado primeiro, depois 1ª aparição (a lista já vem por
 *  prioridade da RPC). Pula precisão boa (street/postcode/rooftop) e CEP já
 *  resolvido/falhado nesta sessão. precisaoVisual é o único juiz de "aproximado". */
export function ordenarFilaGeocodeCep(stops: RouteStop[], estado: EstadoFilaCep): CepPendente[] {
  const porCep = new Map<string, { pend: CepPendente; ordem: number; marcado: boolean }>();
  let ordem = 0;
  for (const s of stops) {
    const cep = normalizarCep(s.address.zip_code);
    if (!cep) continue; // CEP inválido → não geocodificável
    if (!precisaoVisual(s.precisao).aproximado) continue; // já bom o bastante
    if (estado.resolvidos.has(cep) || estado.falhados.has(cep)) continue;
    const marcado = estado.marcados.has(s.id);
    const existente = porCep.get(cep);
    if (!existente) {
      porCep.set(cep, { pend: { cep, cidade: s.address.city, uf: s.address.state }, ordem: ordem++, marcado });
    } else if (marcado && !existente.marcado) {
      existente.marcado = true; // qualquer alvo marcado promove o CEP inteiro
    }
  }
  return [...porCep.values()]
    .sort((a, b) => Number(b.marcado) - Number(a.marcado) || a.ordem - b.ordem)
    .map((x) => x.pend);
}
