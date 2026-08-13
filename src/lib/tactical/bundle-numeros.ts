import { valorMedido } from '@/lib/scoring/margin';

/** Os quatro números do bundle gravados no plano tático. `null` = não há bundle / não medido. */
export interface NumerosDoBundle {
  bundle_lie: number | null;
  bundle_probability: number | null;
  bundle_incremental_margin: number | null;
  best_individual_lie: number | null;
}

/**
 * Números do bundle prioritário para o payload de `criar_plano_tatico`.
 *
 * Espelho EXATO de `numerosDoBundle` em
 * `supabase/functions/generate-tactical-plan/plano-helpers.ts` — o plano é gravado pelos
 * DOIS caminhos (cron self-contained na edge; vendedora clicando "Gerar plano" aqui), e
 * corrigir um só deixa o bug voltar pelo outro. Mudou lá, mude aqui.
 *
 * O que estava errado: `topBundle ? Number(topBundle.lie_bundle) : 0` fabricava 0 em dois
 * cenários — **sem bundle nenhum** e **com bundle de campo nulo** (as três colunas de
 * `farmer_bundle_recommendations` são nullable, e ainda têm `column_default 0`). O 0
 * atravessava até a tela como "LIE R$ 0,00", "Probabilidade 0,0%" e "Margem incremental
 * R$ 0,00": afirmações — *não vale a pena vender este bundle* — que ninguém mediu. A
 * verdade é "não há bundle" ou "não calculado", e a UI já sabe exibir "—".
 *
 * Medido em prod via psql-ro (2026-07-31): **339 de 339 planos** com os três campos = 0 e
 * **nenhum** com `bundle_recommendation_id` ⇒ 100% dos zeros eram ausência de bundle
 * gravada com cara de medição.
 *
 * ⚠️ `0` vindo da coluna é PRESERVADO: zero apurado é veredito, e degradá-lo para null
 * seria o erro simétrico ao que este helper corrige (`valorMedido` faz essa separação).
 *
 * ⚠️ `best_individual_lie` é SEMPRE null: era `0` hardcoded nos dois writers e **nenhum
 * código do repo o calcula** — mesma família de `expansion_score`
 * (20260727130000_farmer_scores_colunas_orfas_null, 6.633/6.633 NULL). Gravar 0 afirmava
 * "nenhum item individual vale a pena" sobre uma conta que não existe.
 *
 * ⚠️ Devolve as QUATRO chaves sempre, porque o call-site monta o payload por spread: uma
 * chave a menos deixaria a coluna cair no `DEFAULT` da tabela em vez de gravar o null.
 */
export function numerosDoBundle(bundle: unknown): NumerosDoBundle {
  const row = (bundle ?? null) as Record<string, unknown> | null;
  return {
    bundle_lie: row ? valorMedido(row.lie_bundle) : null,
    bundle_probability: row ? valorMedido(row.p_bundle) : null,
    bundle_incremental_margin: row ? valorMedido(row.m_bundle) : null,
    best_individual_lie: null,
  };
}
