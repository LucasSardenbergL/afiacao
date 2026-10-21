/**
 * Frequência de recompra e classe de saúde de `calculate-scores` (Venda por cliente, Fase 1a).
 *
 * Até aqui `farmer_client_scores.avg_repurchase_interval` não era calculado por ninguém: o seed
 * gravava 0 e 140 linhas legadas tinham 30 (medido 2026-10-20). Com o teto da base em 1.958, o 30
 * valia ~98 pontos de frequência; com margem/cross-sell/engajamento nulos e os pesos
 * renormalizados, cliente sem compra havia 999 dias caía em "atenção" em vez de "crítico". E a
 * regra de positivação `days > intervalo × 1,5` ficava inerte.
 *
 * Agora o intervalo vem de `get_customer_sales_summary().intervalo_mediano_dias` — mediana dos gaps
 * entre dias DISTINTOS de pedido, NULL com menos de 3 dias. Sem intervalo, a frequência e o
 * componente de recompra do priority SAEM da média (mesma renormalização da margem), em vez de
 * entrar como 0 ou como uma cadência mensal inventada (money-path: ausente ≠ zero).
 *
 * Cliente PERDIDO (sem compra há mais que max(3 × intervalo, 365) dias — a régua do spec, a mesma
 * da situação de recompra) pontua 0 de frequência. Sem isso o intervalo real piorava o defeito em
 * vez de corrigi-lo: 42 dias contra o teto de 1.041 vale ~96 pontos, e na simulação sobre a base de
 * 2026-10-20 343 clientes iriam de "crítico" para "atenção" (323 dos 472 "atenção" com > 365 dias
 * sem compra). Com a régua: "atenção" = 164, só 15 deles com > 365 dias.
 *
 * ⚠️ Espelhado VERBATIM em `supabase/functions/_shared/frequencia-recompra.ts` (Deno não importa de
 * `src/`). A paridade do bloco é pinada por `__tests__/frequencia.test.ts`.
 */
import { valorMedido } from './margin';

// MIRROR-START frequencia-recompra — espelhado verbatim em supabase/functions/_shared/frequencia-recompra.ts
export function intervaloRecompraConhecido(raw: unknown): number | null {
  const v = valorMedido(raw);
  // A mediana dos gaps entre dias DISTINTOS é ≥ 1 por construção: 0 só existe como resíduo do seed.
  return v != null && v > 0 ? v : null;
}

export function clientePerdido(diasDesdeUltimaCompra: number | null, intervalo: number | null): boolean {
  if (diasDesdeUltimaCompra == null || !Number.isFinite(diasDesdeUltimaCompra) || intervalo == null) return false;
  return diasDesdeUltimaCompra > Math.max(3 * intervalo, 365);
}

export function scoreFrequencia(
  intervalo: number | null,
  maxIntervalo: number | null,
  diasDesdeUltimaCompra: number | null,
): number | null {
  if (intervalo == null || maxIntervalo == null || maxIntervalo <= 0) return null;
  // Perdido: a cadência MEDIDA foi quebrada — veredito sobre dois valores medidos, não ausência.
  if (clientePerdido(diasDesdeUltimaCompra, intervalo)) return 0;
  return Math.max(0, 100 - (intervalo / maxIntervalo) * 100);
}

export function componenteRecompra(diasDesdeUltimaCompra: number, intervalo: number | null): number | null {
  if (intervalo == null) return null;
  return Math.max(0, Math.min(100, (1 - Math.abs(diasDesdeUltimaCompra - intervalo) / intervalo) * 100));
}

export function classeSaude(healthScore: number): 'saudavel' | 'estavel' | 'atencao' | 'critico' {
  if (healthScore >= 75) return 'saudavel';
  if (healthScore >= 50) return 'estavel';
  if (healthScore >= 25) return 'atencao';
  return 'critico';
}
// MIRROR-END
