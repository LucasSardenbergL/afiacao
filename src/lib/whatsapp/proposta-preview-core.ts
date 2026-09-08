// Composição PURA do preview da proposta (extraída de usePropostaPreview). Isola o join order×item,
// a inferência de account predominante e o status (codex Risco 2: helpers puros podem estar certos e
// a COMPOSIÇÃO errar por join key/dedupe/dados sujos). Testável sem mockar Supabase.

import type { PedidoLine } from './cesta-recompra';
import type { CrossSellCand } from './cross-sell';

export interface PreviewOrder { id: string; account: string; order_date_kpi: string | null; created_at: string; status: string }
export interface PreviewItem { omie_codigo_produto: number | null; quantity: number; unit_price: number; sales_order_id: string }
export interface PreviewRec { product_id: string | null; affinity_score: number | null; status: string | null; recommendation_type: string | null }
export interface PreviewProdById { id: string; omie_codigo_produto: number; descricao: string; ativo: boolean }

export interface LinesContexto {
  lines: PedidoLine[];
  account: string | null;
  statusesVistos: string[];
  statusValidos: string[];
}

/** order×item → PedidoLine[] + account predominante (tie-break determinístico) + status. */
export function assembleLinesEContexto(orders: PreviewOrder[], items: PreviewItem[], statusCancelamento: Set<string>): LinesContexto {
  if (orders.length === 0) return { lines: [], account: null, statusesVistos: [], statusValidos: [] };

  const porAccount = new Map<string, number>();
  const statusSet = new Set<string>();
  for (const o of orders) {
    porAccount.set(o.account, (porAccount.get(o.account) ?? 0) + 1);
    if (o.status) statusSet.add(o.status);
  }
  // predominante: mais pedidos; empate → nome asc (determinístico)
  const account = [...porAccount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const statusesVistos = [...statusSet].sort();
  const statusValidos = statusesVistos.filter(s => !statusCancelamento.has(s.toUpperCase()));

  const orderById = new Map(orders.map(o => [o.id, o]));
  const lines: PedidoLine[] = [];
  for (const it of items) {
    const ord = orderById.get(it.sales_order_id);
    if (!ord || it.omie_codigo_produto == null) continue; // órfão ou SKU nulo → fora
    lines.push({
      omie_codigo_produto: it.omie_codigo_produto,
      quantity: it.quantity,
      unit_price: it.unit_price,
      order_date: (ord.order_date_kpi ?? ord.created_at).slice(0, 10),
      account: ord.account,
      status: ord.status,
    });
  }
  return { lines, account, statusesVistos, statusValidos };
}

/**
 * Status em que uma recomendação ainda é OFERECÍVEL. Allowlist, não denylist: status
 * novo (hoje 'expirado', amanhã o que for) fica de fora por default — precisão > recall
 * numa lista que vai pro cliente por WhatsApp.
 *
 * ⚠️ O filtro anterior era `r.status === 'rejected'` — rótulo que NÃO existe no domínio
 * (o CHECK da tabela é pt-BR: pendente/ofertado/aceito/rejeitado/expirado), logo nunca
 * casava nada. Isto aqui é DEFESA EM PROFUNDIDADE, não a correção de um bug ativo: a
 * proteção real é o `.eq('status','pendente')` do usePropostaPreview. Vale escrever
 * porque um helper puro que finge filtrar é pior que um que não filtra.
 */
const STATUS_OFERECIVEL = new Set(['pendente', 'ofertado']);

/** farmer_recommendations × omie_products(by id) → candidatos de cross-sell (só ativos e oferecíveis). */
export function buildCrossSellCandidatos(recs: PreviewRec[], prodById: PreviewProdById[]): CrossSellCand[] {
  const byId = new Map(prodById.map(p => [p.id, p]));
  const out: CrossSellCand[] = [];
  for (const r of recs) {
    // CONTRATO antes de tudo: `.eq('recommendation_type', …)` na query FILTRA mas NÃO projeta a
    // coluna. Se o `.select()` a esquecer, o campo chega `undefined` — e tratar isso como "não é
    // cross-sell" descartaria TUDO, zerando a seção dos 238 clientes em silêncio, com o teste do
    // helper VERDE (a fixture fornece o campo que a query esqueceu). Ausente ≠ "não é" — quem não
    // pode decidir tem de DIZER (money-path §6, achado do challenge Codex gpt-6-astra/max).
    if (r.recommendation_type === undefined) {
      throw new Error(
        'buildCrossSellCandidatos: `recommendation_type` ausente no payload — a query precisa ' +
        'PROJETAR a coluna, não só filtrar por ela. Sem isso a seção iria a zero em silêncio.',
      );
    }
    // Só CROSS-SELL: a seção é "experimente também" (produto complementar). `affinity_score`
    // carrega DUAS grandezas incomensuráveis — medido em prod 07/09/2026, o MÍNIMO do up-sell
    // (0,0024) é 8× o p75 do cross-sell (0,0003) —, então ordenar os dois juntos por ele não
    // ranqueia mérito, ranqueia escala: 183 dos 238 clientes recebiam a seção 100% up-sell, ou
    // seja a versão mais CARA do que já compram. Ver docs/historico/affinity-score-duas-grandezas.md
    //
    // O filtro mora AQUI, antes do dedupe por SKU de `selecionarCrossSell`: fosse depois, uma
    // linha up-sell poderia vencer o dedupe de um SKU e levar junto a oportunidade cross-sell
    // daquele mesmo SKU. A query também filtra — ali é a aquisição; aqui é o contrato da SAÍDA,
    // que é o que o nome desta função promete.
    if (r.recommendation_type !== 'cross_sell') continue;
    if (!r.product_id || !STATUS_OFERECIVEL.has(r.status ?? '')) continue;
    const prod = byId.get(r.product_id);
    if (prod && prod.ativo) out.push({ omie_codigo_produto: prod.omie_codigo_produto, nome: prod.descricao, afinidade: r.affinity_score });
  }
  return out;
}
