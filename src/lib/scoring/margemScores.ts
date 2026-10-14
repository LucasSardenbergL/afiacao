import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { margemConhecida } from '@/lib/scoring/margin';

/**
 * Margem bruta PERSISTIDA por cliente (`farmer_client_scores.gross_margin_pct`), lida pela RPC
 * `get_scores_margem` — a única via do browser desde o fecho da coluna (FU4-F, 2026-10-14).
 *
 * A coluna deixou de ser legível por `authenticated` (migration 20261014120100): a RLS da carteira
 * deixava a vendedora ler a margem de cada cliente dela, e para cliente de 1 SKU a margem inverte o
 * custo unitário. Privilégio de coluna é por PAPEL, então o master também perdeu a leitura direta;
 * o número sai daqui, e só para quem tem `private.cap_custo_ler`.
 *
 * ⚠️ Nunca volte a ler `gross_margin_pct` (nem `select('*')`) de `farmer_client_scores` no browser —
 * a query inteira passa a falhar com 42501.
 *
 * Tri-estado, e os dois "sem número" NÃO se confundem:
 *   · `visivel: true,  margem: n`    → apurada;
 *   · `visivel: true,  margem: null` → não apurada (sem custo / sem compra na janela);
 *   · `visivel: false, margem: null` → o servidor NÃO concedeu o número (sem cap_custo_ler).
 * Tratar o terceiro como o segundo faz a tela afirmar "sem compra na janela" sobre um cliente que
 * compra todo mês — fato fabricado.
 */
/** Legenda de quem não tem `cap_custo_ler`: diz por que não há número, sem afirmar nada do cliente. */
export const MARGEM_RESTRITA = 'margem restrita a quem lê custo';

export interface MargemScore {
  margem: number | null;
  visivel: boolean;
}

interface LinhaMargem {
  customer_user_id: string;
  gross_margin_pct: number | string | null;
  margem_visivel: boolean;
}

/**
 * Busca a margem dos clientes pedidos (ou de toda a carteira visível, sem `customerIds`), opcionalmente
 * recortada por `farmerId`. LANÇA em falha — "não consegui ler" nunca vira "margem desconhecida".
 * Cliente ausente do mapa = fora do escopo do caller (a RPC espelha `fcs_select_carteira`).
 */
export async function buscarMargensScores(
  opts: { customerIds?: string[]; farmerId?: string } = {},
): Promise<Map<string, MargemScore>> {
  if (opts.customerIds && opts.customerIds.length === 0) return new Map();
  const linhas = await fetchAllPages<LinhaMargem>(
    (de, ate) =>
      supabase
        .rpc('get_scores_margem', {
          p_customer_ids: opts.customerIds,  // ausente → DEFAULT NULL (toda a carteira visível)
          p_farmer_id: opts.farmerId,
        })
        .order('customer_user_id', { ascending: true })
        .range(de, ate) as unknown as PromiseLike<{ data: LinhaMargem[] | null; error: unknown }>,
    'get_scores_margem',
  );
  const mapa = new Map<string, MargemScore>();
  for (const l of linhas) {
    mapa.set(l.customer_user_id, {
      margem: l.margem_visivel ? margemConhecida(l.gross_margin_pct) : null,
      visivel: l.margem_visivel === true,
    });
  }
  return mapa;
}

/** Atalho de 1 cliente. `null` = cliente fora do escopo do caller (sem linha). */
export async function buscarMargemScore(customerId: string): Promise<MargemScore | null> {
  const mapa = await buscarMargensScores({ customerIds: [customerId] });
  return mapa.get(customerId) ?? null;
}

/**
 * Anexa `gross_margin_pct` + `margem_oculta` a linhas de `farmer_client_scores` lidas SEM a coluna.
 * Linha sem par no mapa = o servidor não a devolveu → `margem_oculta: true` (nunca "não apurada").
 */
export function anexarMargens<T extends { customer_user_id: string }>(
  linhas: T[],
  margens: Map<string, MargemScore>,
): Array<T & { gross_margin_pct: number | null; margem_oculta: boolean }> {
  return linhas.map((l) => {
    const m = margens.get(l.customer_user_id);
    return { ...l, gross_margin_pct: m?.margem ?? null, margem_oculta: m ? !m.visivel : true };
  });
}
