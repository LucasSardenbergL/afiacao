// Helpers puros da listagem unificada de pedidos (view order_feed).
// filterFeedRows: busca + filtro de empresa CLIENT-SIDE sobre o conjunto COMPLETO
// (a view carrega tudo numa query — fim do "Nenhum pedido" falso de quando a busca
// só enxergava as páginas baixadas).
// mapSalesDetail/mapAfiacaoDetail: normalizam a linha crua do detalhe (select('*')
// de sales_orders | orders) pro shape SalesOrder que painel/impressão/share consomem.
import type { Json, Tables } from '@/integrations/supabase/types';
import { exigirColunas } from '@/lib/linha-view';
import {
  COLUNAS_FEED_EXIGIDAS,
  decodeHtml,
  type Account,
  type AfiacaoItemRaw,
  type AfiacaoOrderRow,
  type OrderFeedRow,
  type SalesOrder,
  type SalesOrderItem,
  type SalesOrderRow,
} from './types';
import { totalLinhaOuAusente, precoUtilizavel } from '@/lib/format';

// Normaliza pra busca: minúsculas + sem diacríticos ("afiacao" acha "Afiação").
const normalizar = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function filterFeedRows(
  rows: OrderFeedRow[],
  search: string,
  accountFilter: Account,
): OrderFeedRow[] {
  // Afiação já vem da view com account='colacor_sc' (opera sob a entidade SC),
  // então o filtro de aba é uniforme — sem caso especial.
  let result = accountFilter === 'all' ? rows : rows.filter((r) => r.account === accountFilter);

  const q = normalizar(search.trim());
  if (q) {
    // Busca numérica em formato BR: "250,50" também casa o total 250.50.
    const qNum = q.replace(',', '.');
    result = result.filter((r) => {
      const name = normalizar(decodeHtml(r.customer_name || ''));
      const pv = (r.order_number || '').toLowerCase();
      const items = normalizar((r.item_names || []).join(' '));
      const total = Number(r.total ?? 0).toFixed(2);
      return name.includes(q) || pv.includes(q) || items.includes(q) || total.includes(q) || total.includes(qNum);
    });
  }
  return result;
}

const ORIGENS_FEED: readonly OrderFeedRow['origin'][] = ['sales', 'afiacao'];

/**
 * Borda da view `order_feed`: exige as colunas-chave (lança se vierem nulas — 0 em 31.955 linhas na
 * prod em 2026-10-20) e estreita `origin`. Antes um cast duplo para `OrderFeedRow[]` afirmava tudo.
 */
export function feedRowDaLinha(linha: Tables<'order_feed'>): OrderFeedRow {
  exigirColunas(linha, COLUNAS_FEED_EXIGIDAS, 'order_feed');
  const origin = ORIGENS_FEED.find((o) => o === linha.origin);
  if (!origin) throw new Error(`order_feed ${linha.id}: origin desconhecida (${linha.origin})`);
  return { ...linha, origin };
}

// Dedupe por (origin, id) preservando a 1ª ocorrência. Defesa contra o caso raro
// de escrita concorrente durante o fetch paginado por offset (uma inserção entre
// as páginas pode deslocar e repetir uma linha — duplicata quebraria as keys do React).
export function dedupeFeedRows(rows: OrderFeedRow[]): OrderFeedRow[] {
  const seen = new Set<string>();
  const out: OrderFeedRow[] = [];
  for (const r of rows) {
    const key = `${r.origin}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

type ObjetoJson = { [chave: string]: Json | undefined };

function campoOpcional<T extends Json>(o: ObjetoJson, chave: string, ok: (v: Json) => v is T, onde: string): T | undefined {
  const v = o[chave];
  if (v === undefined) return undefined;
  if (!ok(v)) throw new Error(`${onde}: "${chave}" fora da forma`);
  return v;
}
const ehTexto = (v: Json): v is string => typeof v === 'string';
const ehNumeroOuNulo = (v: Json): v is number | null => v === null || typeof v === 'number';

/**
 * Um item do jsonb lido para o PAINEL/IMPRESSÃO: só os campos que eles mostram, por forma; tipo
 * trocado lança. Chaves que o tipo não conhece seguem no objeto (a impressão lê `codigo`/`tint_*`).
 */
function itemDetalheDoJson(item: Json, onde: string): SalesOrderItem {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`${onde}: item não é objeto`);
  const { descricao, quantidade, valor_unitario } = item;
  if (typeof descricao !== 'string' || typeof quantidade !== 'number' || !(valor_unitario === null || typeof valor_unitario === 'number')) {
    throw new Error(`${onde}: item fora da forma {descricao, quantidade, valor_unitario}`);
  }
  const conhecido: SalesOrderItem = {
    descricao,
    quantidade,
    valor_unitario,
    valor_total: campoOpcional(item, 'valor_total', ehNumeroOuNulo, onde),
    codigo: campoOpcional(item, 'codigo', ehTexto, onde),
    unidade: campoOpcional(item, 'unidade', ehTexto, onde),
    tint_cor_id: campoOpcional(item, 'tint_cor_id', ehTexto, onde),
    tint_nome_cor: campoOpcional(item, 'tint_nome_cor', ehTexto, onde),
  };
  for (const chave of Object.keys(conhecido) as (keyof SalesOrderItem)[]) {
    if (conhecido[chave] === undefined) delete conhecido[chave];
  }
  return { ...item, ...conhecido };
}

/** As colunas que `fetchOrderDetail` seleciona de `sales_orders` (omie_payload vem pelo canal staff). */
export type LinhaDetalheVenda = Pick<
  SalesOrderRow,
  | 'id' | 'customer_user_id' | 'items' | 'subtotal' | 'discount' | 'total' | 'status' | 'notes' | 'account'
  | 'omie_pedido_id' | 'omie_numero_pedido' | 'created_at' | 'customer_address' | 'customer_phone'
>;

// sales_orders → SalesOrder: marca a origem e lê `items` por forma. jsonb que NÃO é array (objeto no
// lugar da lista) segue virando [] — o painel/impressão não podem crashar (achado do codex).
export function mapSalesDetail(row: LinhaDetalheVenda): SalesOrder {
  const items = Array.isArray(row.items)
    ? row.items.map((it, i) => itemDetalheDoJson(it, `sales_orders ${row.id} item ${i}`))
    : [];
  return { ...row, discount: row.discount ?? undefined, items, _source: 'sales' };
}

const ehTextoOuNulo = (v: Json): v is string | null => v === null || typeof v === 'string';

/** Item de `orders.items` (afiação): todos os campos opcionais/nuláveis; tipo trocado lança. */
function itemAfiacaoDoJson(item: Json, onde: string): AfiacaoItemRaw {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`${onde}: item não é objeto`);
  return {
    category: campoOpcional(item, 'category', ehTextoOuNulo, onde),
    name: campoOpcional(item, 'name', ehTextoOuNulo, onde),
    quantity: campoOpcional(item, 'quantity', ehNumeroOuNulo, onde),
    unitPrice: campoOpcional(item, 'unitPrice', ehNumeroOuNulo, onde),
  };
}

// orders (afiação).* → SalesOrder. Mesma normalização que a listagem antiga fazia
// inline (category||name → descricao; quantity default 1; account = entidade SC).
export function mapAfiacaoDetail(row: AfiacaoOrderRow): SalesOrder {
  const rawItems = Array.isArray(row.items)
    ? row.items.map((it, i) => itemAfiacaoDoJson(it, `orders ${row.id} item ${i}`))
    : [];
  return {
    id: row.id,
    customer_user_id: row.user_id,
    items: rawItems.map((i) => ({
      descricao: i.category || i.name || 'Afiação',
      // ?? (não ||): quantity 0 real fica 0 — mesma regra da view (ausente → 1).
      quantidade: i.quantity ?? 1,
      // Serviço de AFIAÇÃO (tabela `orders`), não pedido Omie — mas o mesmo `|| 0` e a mesma
      // tela. O item alimenta `SalesOrderItem`, que passou a admitir `null`, e o DetailSheet
      // já sabe mostrar "—". Preço 0 aqui costuma ser "a orçar", que é ausência, não brinde.
      valor_unitario: precoUtilizavel(i.unitPrice),
      valor_total: totalLinhaOuAusente(i.quantity ?? 1, precoUtilizavel(i.unitPrice)),
    })),
    subtotal: row.subtotal || row.total || 0,
    total: row.total || 0,
    status: row.status,
    omie_numero_pedido: null,
    omie_pedido_id: null,
    created_at: row.created_at,
    notes: row.notes,
    account: 'colacor_sc',
    _source: 'afiacao',
  };
}
