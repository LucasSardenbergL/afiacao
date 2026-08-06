/**
 * Potencial comercial utilizável, ou `null` se não medido.
 *
 * Quarto irmão de `margemConhecida` (`./margin`) e `churnConhecido` (`./churn`), com a mesma
 * semântica e pela mesma razão. Cobre as colunas de `farmer_client_scores` que **nunca tiveram
 * produtor**: `expansion_score`, `revenue_potential`, `recover_score`, `x_score`, `s_score`,
 * `eff_score` — todas `NULL` em 6.633/6.633 linhas (medido 2026-07-27, ver
 * `src/lib/scoring/colunas-sem-produtor.ts`).
 *
 * Diferente dos irmãos, aqui a ausência NÃO é hipótese futura: é 100% da base hoje. O
 * `Number(x ?? 0)` que este helper substitui fabricava um número de decisão para toda a
 * carteira — a missão de expansão sumiu da agenda e 35% do `priority_score` ficou constante
 * desde março de 2026.
 *
 * ⚠️ `0` é CONHECIDO — o veredito "medi e não há potencial". Só null/undefined/NaN/Infinity e
 * lixo coagível são ausência. Confundir os dois é o erro que este helper impede.
 *
 * ⚠️ Fail-closed de propósito, e NÃO `Number.isFinite` puro: `Number('')`, `Number('  ')`,
 * `Number(false)` e `Number([])` são todos **0** — lixo viraria "medi e deu zero".
 *
 * ⚠️ Em comparação relacional o guard é obrigatório: `null <= 0` é `true` e `null > 50` é
 * `false` (null coage a 0), então `if (potencial > 50)` sem checar null classifica como "sem
 * potencial" justamente quem não foi medido.
 *
 * Espelhado em `supabase/functions/visit-score-recalc-client/index.ts` (Deno não importa de
 * `src/`), sob o bloco `// MIRROR-START potencial-conhecido`.
 */
export function potencialConhecido(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
