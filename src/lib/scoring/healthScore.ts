// Composição do health score do motor client-side (useFarmerScoring).
//
// Extraído para cá porque a regra que importa — o que fazer quando uma dimensão é
// DESCONHECIDA — não era testável dentro do hook (query + agregação no meio do caminho).
//
// ESPELHO da renormalização aplicada em `supabase/functions/calculate-scores` pelo #1495.
// Os dois motores calculam o mesmo score; se só um renormalizar, o mesmo cliente recebe
// notas diferentes conforme a tela que o carregou.

/** Dimensões do health score, em escala 0-1. `g` (margem) é `null` quando desconhecida. */
export interface DimensoesHealth {
  /** Recência/frequência. */
  rf: number;
  /** Monetário. */
  m: number;
  /** Margem bruta — `null` quando nenhum item do cliente tem custo conhecido. */
  g: number | null;
  /** Diversidade de mix. */
  x: number;
  /** Engajamento. */
  s: number;
}

export interface PesosHealth {
  rf: number;
  m: number;
  g: number;
  x: number;
  s: number;
}

/** Health score 0-100 pela média ponderada das dimensões CONHECIDAS.
 *
 *  ⚠️ Margem desconhecida sai da conta e seu peso é redistribuído — não entra como 0.
 *  Zero não é neutro numa média ponderada: é a pior nota do eixo, então o cliente cujos
 *  itens não têm custo apurado levaria até 15 pontos de penalidade por ausência de dado,
 *  ficando indistinguível de um cliente medido e genuinamente ruim (money-path: ausente ≠
 *  zero). `g = 0` CONHECIDO continua penalizando: aí é veredito, não ignorância.
 *
 *  A divisão por `pesoTotal` normaliza a escala, então pesos que não somam 1 continuam
 *  produzindo 0-100. Todos os pesos zerados → 0 (nunca NaN de 0/0). */
export function calcularHealthScore(dim: DimensoesHealth, pesos: PesosHealth): number {
  const pesoG = dim.g == null ? 0 : pesos.g;
  const pesoTotal = pesos.rf + pesos.m + pesoG + pesos.x + pesos.s;
  if (pesoTotal <= 0) return 0;
  const soma =
    pesos.rf * dim.rf +
    pesos.m * dim.m +
    pesoG * (dim.g ?? 0) +
    pesos.x * dim.x +
    pesos.s * dim.s;
  return 100 * (soma / pesoTotal);
}
