/**
 * F1 (reset-path robusto) — alvos do auto-seed de `farmer_client_scores`.
 *
 * O seed do `calculate-scores` deixou de ser "tudo-ou-nada quando a tabela está
 * vazia" (gate `length === 0`, frágil: 1 linha esparsa do `scoring-recalc-client`
 * suprimia o seed inteiro num reset → milhares de clientes nunca semeados, e a
 * linha esparsa com `days_since_last_purchase=0` fabricava recência=100). Agora o
 * seed completa os clientes FALTANTES: elegíveis (de `omie_clientes`) que NÃO são
 * flaggeds (fornecedor fora da carteira) e ainda NÃO têm linha em
 * `farmer_client_scores`.
 *
 * Função PURA e testável (vitest). É espelhada inline no edge `calculate-scores`
 * (Deno não importa de `src/`) — a fonte da verdade é este arquivo; o espelho é
 * trivial (diferença de conjunto) e carimbado com comentário no edge.
 *
 * Money-path: precisão > recall. Nunca semeia flaggeds (anti-ressurreição de
 * fornecedor); nunca re-semeia quem já tem linha (o seed não é dono dos campos
 * computados, só cria o que falta); deduplica a entrada por garantia.
 */

export function computeSeedTargets<T extends { user_id: string }>(
  eligible: readonly T[],
  existingCustomerIds: ReadonlySet<string>,
  flagged: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of eligible) {
    if (!c.user_id) continue; // guard: linha sem user_id (não vira score órfão)
    if (flagged.has(c.user_id)) continue; // fornecedor fora da carteira
    if (existingCustomerIds.has(c.user_id)) continue; // já tem linha (não re-semeia)
    if (seen.has(c.user_id)) continue; // dedup (omie_clientes pode repetir user_id)
    seen.add(c.user_id);
    out.push(c);
  }
  return out;
}
