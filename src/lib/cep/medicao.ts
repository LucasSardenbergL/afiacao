// Núcleo PURO da medição do gate CEP Aberto (Sub-PR 3, geocoding por CEP).
// "Meça antes de confiar" (Codex): antes de importar 1,1M CEPs, medimos numa AMOSTRA
// estratificada dos nossos CEPs — cobertura (o CEP Aberto tem a coord?) + precisão
// (a coord concorda com o Nominatim do mesmo CEP?). Esta lógica decide um veredito
// que afeta o mapa de visitas → é testada (distância errada = veredito errado).

// Haversine: distância em km entre dois pontos (lat/lng em graus). Correto p/ as
// distâncias curtas do gate (concordância CEP Aberto × Nominatim do mesmo CEP).
export function distanciaKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371; // raio médio da Terra (km)
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Amostra estratificada: até nPorUf itens por UF, ordem estável (DETERMINÍSTICA —
// sem Math.random, p/ reprodutibilidade do gate). Pega os primeiros nPorUf de cada UF.
export function amostrarPorUf<T extends { uf: string }>(itens: T[], nPorUf: number): T[] {
  const contagem = new Map<string, number>();
  const out: T[] = [];
  for (const it of itens) {
    const uf = (it.uf ?? '').toUpperCase();
    const n = contagem.get(uf) ?? 0;
    if (n < nPorUf) {
      out.push(it);
      contagem.set(uf, n + 1);
    }
  }
  return out;
}

export interface AmostraMedida {
  coberto: boolean; // CEP Aberto retornou coordenada?
  distanciaKm: number | null; // distância vs referência (Nominatim); null se sem ref
}

export interface ResumoMedicao {
  total: number;
  cobertos: number;
  coberturaPct: number; // 0..100
  comReferencia: number;
  distMedianaKm: number | null;
  distP90Km: number | null;
  grosseirosMaior10km: number; // outliers (>10km = provável erro de cidade)
}

// Percentil por nearest-rank (suficiente p/ o gate; sem interpolação).
function percentil(ordenado: number[], p: number): number | null {
  if (ordenado.length === 0) return null;
  const i = Math.min(ordenado.length - 1, Math.floor((p / 100) * ordenado.length));
  return ordenado[i];
}

export function resumoMedicao(amostras: AmostraMedida[]): ResumoMedicao {
  const total = amostras.length;
  const cobertos = amostras.filter((a) => a.coberto).length;
  const dists = amostras
    .filter((a) => a.distanciaKm != null)
    .map((a) => a.distanciaKm as number)
    .sort((x, y) => x - y);
  return {
    total,
    cobertos,
    coberturaPct: total ? Math.round((cobertos / total) * 1000) / 10 : 0,
    comReferencia: dists.length,
    distMedianaKm: percentil(dists, 50),
    distP90Km: percentil(dists, 90),
    grosseirosMaior10km: dists.filter((d) => d > 10).length,
  };
}
