// Margem no plano tático: gate de R$/h, cluster de comparação e objetivo estratégico.
//
// ESPELHO dos oráculos vitest do front (Deno não importa de src/) — mudou aqui, mude lá:
//   src/lib/tactical/pregeracao.ts        → profitPerHora · selecionarParaPregeracao
//   src/lib/scoring/objective.ts          → selectObjective
//   src/hooks/useTacticalPlan.ts:404-418  → calcularClusterMargin
//
// PRINCÍPIO (money-path, "ausente ≠ zero"): margem desconhecida degrada para `null` e o
// consumidor EXCLUI o cliente do cálculo. Nunca 0 (que significa "cliente não-lucrativo",
// um veredito de negócio) nem um número médio fabricado (que vira régua invisível).
// Mesma semântica que src/lib/scoring/margin.ts aplica a SKU sem custo (#1466/#1468).

export const PROFIT_PER_HOUR_THRESHOLD = 50; // R$/h — espelha src/lib/tactical/pregeracao.ts
const AVG_CALL_MINUTES = 15;

/** Margem utilizável, ou null se desconhecida/não-finita.
 *  ⚠️ `0` é CONHECIDO (margem nula real); só null/undefined/NaN/Infinity são ausência. */
export function margemConhecida(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** R$/h estimado por ligação. Margem desconhecida → `null` ("não sei"), nunca 0. */
export function profitPerHora(rev: number, avg: number, marginPct: unknown): number | null {
  const margem = margemConhecida(marginPct);
  if (margem == null) return null;
  const baseRev = rev > 0 ? rev : avg;
  // 10% do GMV como proxy de margem operacional; visita ~15 min → 4 visitas/h.
  return (baseRev * (margem / 100) * 0.1) / (AVG_CALL_MINUTES / 60);
}

export interface LinhaSelecao {
  customer: string;
  priority: number;
  rev: number;
  avg: number;
  marginPct: number | null;
}

/** Top-N por priority desc DENTRE os que passam no gate de R$/h (filtra ANTES de cortar).
 *
 *  Margem desconhecida sai em `semMargem`, não em `selecionados`: sem margem o gate não é
 *  decidível, e reprovar por omissão confundiria "não sei" com "cliente ruim". O chamador
 *  DEVE reportar `semMargem` — corte silencioso leria como "cobri todo mundo" sem ter
 *  coberto (money-path: no silent caps). */
export function selecionarParaPregeracao(
  scores: LinhaSelecao[],
  topN: number,
): { selecionados: LinhaSelecao[]; semMargem: LinhaSelecao[] } {
  const ordenados = [...scores].sort((a, b) => b.priority - a.priority);
  const semMargem = ordenados.filter((s) => margemConhecida(s.marginPct) == null);
  const selecionados = ordenados
    .filter((s) => {
      const pph = profitPerHora(s.rev, s.avg, s.marginPct);
      return pph != null && pph >= PROFIT_PER_HOUR_THRESHOLD;
    })
    .slice(0, topN);
  return { selecionados, semMargem };
}

/** Margem média dos PARES da carteira, contando SÓ quem tem margem conhecida.
 *  Nenhum par com margem → `null`. NUNCA um default fabricado: este número é a RÉGUA
 *  contra a qual a margem do cliente é julgada (`marginPct < cluster * 0.8`), então um
 *  cluster inventado produz um veredito inventado — e plausível o bastante para passar. */
export function calcularClusterMargin(
  peers: Array<{ gross_margin_pct?: unknown }> | null | undefined,
): number | null {
  const margens = (peers ?? [])
    .map((p) => margemConhecida(p.gross_margin_pct))
    .filter((m): m is number => m != null);
  if (margens.length === 0) return null;
  return margens.reduce((s, m) => s + m, 0) / margens.length;
}

/** Perfil comercial do cliente — espelho de useTacticalPlan.ts:187 (classifyProfile).
 *
 *  Os dois primeiros ramos dependem da margem e só disparam com margem CONHECIDA.
 *  ⚠️ Sem esse guard a coerção do JS fabricaria diagnóstico: `null < 20` é `true`
 *  (null coage a 0), então todo cliente de gasto baixo e margem desconhecida seria
 *  rotulado "sensível a preço" — e esse rótulo entra no prompt da IA e molda a
 *  abordagem que a vendedora leva para a rua. */
export function classifyProfile(
  healthScore: number,
  avgSpend: number,
  marginPct: number | null,
  categoryCount: number,
): string {
  const m = margemConhecida(marginPct);
  if (m != null && avgSpend < 500 && m < 20) return 'sensivel_preco';
  if (m != null && m > 35 && categoryCount <= 3) return 'orientado_qualidade';
  if (avgSpend > 2000 && categoryCount >= 4 && healthScore > 60) return 'orientado_produtividade';
  return 'misto';
}

/** Objetivo estratégico — espelho de src/lib/scoring/objective.ts.
 *  Regras em ORDEM (a primeira que casa vence); ver o oráculo para o porquê de cada fronteira.
 *
 *  Divergência DELIBERADA do oráculo: aqui `marginPct` também aceita null (o front recebe o
 *  valor já numerizado). Sem a margem do cliente a regra de consolidação é indecidível —
 *  não se afirma "margem baixa vs. pares" sem saber a margem. */
export function selectObjective(
  churnRisk: number,
  mixGap: number,
  marginPct: number | null,
  clusterMargin: number | null,
  daysSince: number,
  recencyCapDays: number,
  salesHistoryStatus: string | null = null,
): string {
  if (salesHistoryStatus === 'sem_historico') return 'ativacao';
  if (daysSince >= recencyCapDays) return 'reativacao';
  if (churnRisk > 60) return 'recuperacao';
  if (mixGap > 3) return 'expansao_mix';
  const m = margemConhecida(marginPct);
  const c = margemConhecida(clusterMargin);
  if (m != null && c != null && m < c * 0.8) return 'consolidacao_margem';
  return 'upsell_premium';
}

export interface CanariaResultado {
  nome: string;
  got: unknown;
  expected: unknown;
  ok: boolean;
}

/** CANÁRIA COMPORTAMENTAL do #1498 — prova de DEPLOY, não de fonte.
 *
 *  Roda as decisões deste módulo sobre fixtures fixos e confere contra o esperado. Cada caso é
 *  uma das fabricações que o #1498 removeu, e o `expected` difere do que o código ANTIGO daria —
 *  um fixture que os dois códigos resolvem igual não prova deploy. A edge `generate-tactical-plan`
 *  expõe isto via `{ canary: true }` (staff/cron-gated). Por que ela é necessária: o dado de prod
 *  NÃO discrimina os dois códigos (o gate de R$/h filtra estruturalmente quem não tem margem, o
 *  único caso onde eles divergem), então só um probe do COMPORTAMENTO deployado responde "está no
 *  ar?". Ver o comentário na edge para o histórico completo. */
export function avaliarCanariaMargem(): { ok: boolean; resultados: CanariaResultado[] } {
  const casos: Array<Omit<CanariaResultado, 'ok'>> = [
    // `?? 0`: margem ausente virava R$ 0/h e o cliente sumia do ranking como se fosse ruim.
    { nome: 'margem_ausente_nao_vira_zero', got: margemConhecida(null), expected: null },
    // Margem 0 é veredito REAL ("cliente não-lucrativo") e tem de sobreviver ao guard.
    { nome: 'zero_e_conhecido', got: margemConhecida(0), expected: 0 },
    // `: 25` mágico: sem par com margem, o cluster virava régua inventada.
    { nome: 'cluster_sem_pares_e_null', got: calcularClusterMargin([]), expected: null },
    // `null < 20` é true em JS: sem guard, gasto baixo + margem ausente = "sensivel_preco".
    { nome: 'perfil_nao_fabrica_sensivel_preco', got: classifyProfile(50, 400, null, 5), expected: 'misto' },
    // A régua de consolidação não decide sem os dois lados conhecidos.
    { nome: 'objetivo_sem_margem_nao_consolida', got: selectObjective(10, 1, null, 50, 5, 180), expected: 'upsell_premium' },
  ];
  const resultados = casos.map((c) => ({ ...c, ok: c.got === c.expected }));
  return { ok: resultados.every((r) => r.ok), resultados };
}
