import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { margemConhecida } from '@/lib/scoring/margin';

/**
 * Margem gravada no plano tático (`current_margin_pct`, `cluster_avg_margin_pct` e os cenários de
 * margem em `expected_result`), lida pela RPC `get_planos_margem` — a única via do browser desde o
 * fecho das colunas (FU4-F, migration 20261015120100).
 *
 * A policy de SELECT de `farmer_tactical_plans` é staff-wide: qualquer vendedora lia a margem de
 * qualquer cliente com plano. Privilégio de coluna é por PAPEL, então o master também perdeu a
 * leitura direta; o número sai daqui, e só para quem tem `private.cap_custo_ler`.
 *
 * ⚠️ Nunca volte a ler essas três colunas (nem `select('*')`) de `farmer_tactical_plans` no browser —
 * a query inteira passa a falhar com 42501. A lista legível é `COLUNAS_PLANO_TATICO`.
 *
 * Tri-estado do acesso, e os três NÃO se confundem:
 *   · `concedida`  → o servidor mandou o número (que ainda pode ser null = não apurado na geração);
 *   · `restrita`   → o servidor NÃO concedeu o número (sem cap_custo_ler) — a tela não fala de margem;
 *   · `indisponivel` → a leitura falhou; nada se afirma sobre o cliente.
 */
export type AcessoMargemPlano = 'concedida' | 'restrita' | 'indisponivel';

/** Colunas de `farmer_tactical_plans` legíveis por authenticated depois da 20261015120100 (38 de 41). */
export const COLUNAS_PLANO_TATICO =
  'id, farmer_id, customer_user_id, bundle_recommendation_id, health_score, churn_risk, mix_gap, ' +
  'expansion_potential, strategic_objective, customer_profile, top_bundle, bundle_lie, bundle_probability, ' +
  'bundle_incremental_margin, best_individual_lie, diagnostic_questions, implication_question, ' +
  'offer_transition, probable_objections, approach_strategy, plan_followed, call_result, actual_margin, ' +
  'call_duration_seconds, objection_type, notes, effectiveness_score, status, generated_at, used_at, ' +
  'completed_at, created_at, updated_at, plan_type, approach_strategy_b, second_bundle, ltv_projection, ' +
  'operational_risks';

export interface CenariosMargem {
  best_case_margin: number | null;
  likely_margin: number | null;
  worst_case_margin: number | null;
}

export interface MargemPlano {
  acesso: AcessoMargemPlano;
  atual: number | null;
  cluster: number | null;
  cenarios: CenariosMargem | null;
}

/** Sem leitura (falha) — usado quando a RPC não respondeu. */
export const MARGEM_PLANO_INDISPONIVEL: MargemPlano = { acesso: 'indisponivel', atual: null, cluster: null, cenarios: null };

interface LinhaMargemPlano {
  plan_id: string;
  current_margin_pct: number | string | null;
  cluster_avg_margin_pct: number | string | null;
  expected_result: unknown;
  margem_visivel: boolean;
}

function cenariosDe(v: unknown): CenariosMargem | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const cenarios: CenariosMargem = {
    best_case_margin: margemConhecida(c.best_case_margin),
    likely_margin: margemConhecida(c.likely_margin),
    worst_case_margin: margemConhecida(c.worst_case_margin),
  };
  const algum = cenarios.best_case_margin != null || cenarios.likely_margin != null || cenarios.worst_case_margin != null;
  return algum ? cenarios : null;
}

/**
 * Margem dos planos pedidos. LANÇA em falha — "não consegui ler" nunca vira "margem restrita" nem
 * "não apurada"; o chamador decide degradar para `MARGEM_PLANO_INDISPONIVEL`.
 * Plano ausente do mapa = o servidor não o devolveu (fora do escopo do caller).
 * Paginada mesmo devolvendo só os ids pedidos: a capa de 1.000 do PostgREST vale para `.rpc()` e o
 * gate `rpc-set-returning-paginacao-gate` não aceita chamada nova sem `.range()`.
 */
export async function buscarMargensPlanos(planIds: string[]): Promise<Map<string, MargemPlano>> {
  if (planIds.length === 0) return new Map();
  const linhas = await fetchAllPages<LinhaMargemPlano>(
    (de, ate) =>
      supabase
        .rpc('get_planos_margem', { p_plan_ids: planIds })
        .order('plan_id', { ascending: true })
        .range(de, ate) as unknown as PromiseLike<{ data: LinhaMargemPlano[] | null; error: unknown }>,
    'get_planos_margem',
  );
  const mapa = new Map<string, MargemPlano>();
  for (const l of linhas) {
    const visivel = l.margem_visivel === true;
    mapa.set(l.plan_id, {
      acesso: visivel ? 'concedida' : 'restrita',
      atual: visivel ? margemConhecida(l.current_margin_pct) : null,
      cluster: visivel ? margemConhecida(l.cluster_avg_margin_pct) : null,
      cenarios: visivel ? cenariosDe(l.expected_result) : null,
    });
  }
  return mapa;
}
