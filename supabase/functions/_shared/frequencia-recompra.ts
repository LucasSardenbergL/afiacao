/**
 * Frequência de recompra e classe de saúde de `calculate-scores` (Venda por cliente, Fase 1a).
 *
 * Módulo próprio, e não inline no `index.ts`, pelo mesmo motivo de `score-ponderado.ts`: o index
 * importa `npm:@supabase/supabase-js` e `test:edges` roda com `--no-remote`, então a regra inline
 * seria inalcançável por teste de comportamento. Ver `frequencia-recompra_test.ts`.
 *
 * O canônico é `src/lib/scoring/frequencia.ts` (lá está o porquê inteiro); Deno não importa de
 * `src/`, daí o espelho VERBATIM abaixo, pinado por `src/lib/scoring/__tests__/frequencia.test.ts`.
 */
import { valorMedido } from "./score-ponderado.ts";

// MIRROR-START frequencia-recompra — espelhado verbatim de src/lib/scoring/frequencia.ts
export function intervaloRecompraConhecido(raw: unknown): number | null {
  const v = valorMedido(raw);
  // A mediana dos gaps entre dias DISTINTOS é ≥ 1 por construção: 0 só existe como resíduo do seed.
  return v != null && v > 0 ? v : null;
}

export function scoreFrequencia(intervalo: number | null, maxIntervalo: number | null): number | null {
  if (intervalo == null || maxIntervalo == null || maxIntervalo <= 0) return null;
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
