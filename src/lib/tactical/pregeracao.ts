/** Pré-geração noturna do plano tático: gate de eficiência + seleção dos prioritários.
 *  Oráculo puro — a edge tactical-plans-batch (Deno) replica esta lógica via
 *  supabase/functions/_shared/tactical-margem.ts (front e edge não compartilham módulo;
 *  este helper é a fonte da verdade testada). */
import { margemConhecida } from '@/lib/scoring/margin';

export const PROFIT_PER_HOUR_THRESHOLD = 50; // R$/h — espelha useTacticalPlan.ts:198
const AVG_CALL_MINUTES = 15;

export interface ScoreParaSelecao {
  customerUserId: string;
  priorityScore: number;
  revenuePotential: number;
  avgSpend: number;
  /** null = margem DESCONHECIDA. Não confundir com 0, que é margem nula CONHECIDA. */
  marginPct: number | null;
}

// margemConhecida vem de @/lib/scoring/margin (era uma cópia privada aqui). A cópia que RESTA é a
// de supabase/functions/_shared/tactical-margem.ts, e essa é inevitável: Deno não importa de src/.

/** R$/h estimado por ligação. Espelha useTacticalPlan.checkEfficiency (linhas 313-318).
 *  Margem desconhecida → `null` ("não sei"), NUNCA 0 (que significaria "cliente não-lucrativo"). */
export function profitPerHora(
  s: Pick<ScoreParaSelecao, 'revenuePotential' | 'avgSpend' | 'marginPct'>,
): number | null {
  const margem = margemConhecida(s.marginPct);
  if (margem == null) return null;
  const base = s.revenuePotential > 0 ? s.revenuePotential : s.avgSpend;
  const marginPerCall = base * (margem / 100) * 0.1;
  return marginPerCall / (AVG_CALL_MINUTES / 60);
}

/** Top-N por priorityScore desc, filtrando quem passa no gate de R$/h e ainda NÃO está na fila.
 *  Filtra ANTES de cortar: retorna os N de maior priority DENTRE OS ELEGÍVEIS.
 *
 *  Quem tem margem desconhecida sai em `semMargem`, NÃO em `selecionados`: o gate não é
 *  decidível sem margem, e tratá-lo como reprovado o confundiria com um cliente de margem
 *  genuinamente ruim. `semMargem` existe para o chamador CONTABILIZAR o descarte — corte
 *  silencioso leria como "cobri todo mundo" sem ter coberto (money-path: no silent caps).
 *
 *  `jaNaFila` (clientes com plano ABERTO) é excluído AQUI e não no call-site, e a ordem é o
 *  ponto todo: com topN pequeno, filtrar DEPOIS do corte congelaria a fila. O batch escolheria
 *  todo dia os mesmos topN de maior priority, a idempotência os pularia, e o cliente de posição
 *  topN+1 nunca entraria — fila parada com aparência de funcionamento. Medido em prod
 *  (2026-08-08): 23 dos 25 planos do dia eram regeração de cliente que já estava na fila; a
 *  fila viva tinha 169 planos para 35 clientes, 14 deles com 7 cópias cada.
 *
 *  `naFila` e `semMargem` PODEM SE SOBREPOR — são recortes independentes, não uma partição.
 *  `semMargem` mede a cegueira da CARTEIRA (quantos clientes não são avaliáveis) e por isso é
 *  contado sobre todos os scores: se ele passasse a excluir quem está na fila, encher a fila
 *  faria a cegueira "melhorar" sozinha, e o número deixaria de servir de sinal. */
export function selecionarParaPregeracao(
  scores: ScoreParaSelecao[],
  topN: number,
  jaNaFila: ReadonlySet<string> = new Set(),
): {
  selecionados: ScoreParaSelecao[];
  semMargem: ScoreParaSelecao[];
  naFila: ScoreParaSelecao[];
} {
  const ordenados = [...scores].sort((a, b) => b.priorityScore - a.priorityScore);
  const semMargem = ordenados.filter((s) => margemConhecida(s.marginPct) == null);
  const naFila = ordenados.filter((s) => jaNaFila.has(s.customerUserId));
  const selecionados = ordenados
    .filter((s) => {
      if (jaNaFila.has(s.customerUserId)) return false;
      const pph = profitPerHora(s);
      return pph != null && pph >= PROFIT_PER_HOUR_THRESHOLD;
    })
    .slice(0, topN);
  return { selecionados, semMargem, naFila };
}
