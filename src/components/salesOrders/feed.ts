// Helpers puros da listagem unificada de pedidos (view order_feed).
// padraoBuscaFeed: o termo da busca como o servidor o compara com a coluna `busca` (a busca alcança
// os ~32 k pedidos, não só as páginas baixadas).
// mapSalesDetail/mapAfiacaoDetail: normalizam a linha crua do detalhe (select('*')
// de sales_orders | orders) pro shape SalesOrder que painel/impressão/share consomem.
import type { Json } from '@/integrations/supabase/types';
import { exigirColunas } from '@/lib/linha-view';
import { ilikeContainsPattern, orFilter } from '@/lib/postgrest';
import {
  COLUNAS_FEED_EXIGIDAS,
  type AfiacaoItemRaw,
  type LinhaOrderFeed,
  type AfiacaoOrderRow,
  type OrderFeedRow,
  type SalesOrder,
  type SalesOrderItem,
  type SalesOrderRow,
} from './types';
import { totalLinhaOuAusente, precoUtilizavel } from '@/lib/format';

// Normaliza pra busca: minúsculas + sem diacríticos ("afiacao" acha "Afiação").
const normalizar = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Colunas que a listagem baixa — todas as da view MENOS `busca`, que só serve de filtro no servidor.
 * O `select` tipado do supabase-js deriva daqui o tipo da linha (`LinhaOrderFeed`).
 */
export const COLUNAS_LISTAGEM_FEED =
  'origin,id,created_at,account,order_number,omie_pedido_id,customer_user_id,customer_name,item_names,item_quantity,status,subtotal,total' as const;

/**
 * Padrão do `.ilike('busca', …)` da listagem, ou `null` quando não há o que buscar.
 * A coluna `busca` da view (migration 20261101221452) já vem em minúsculas e sem acento, com o nome
 * do cliente (entidades HTML decodificadas), o nº do pedido, os itens e o total em "250.50" e
 * "250,50" — por isso basta normalizar o termo do mesmo jeito: "afiacao" acha "Afiação", "250,5"
 * acha o total 250.50. Os curingas do usuário (`%`, `_`, `*`) saem em `ilikeContainsPattern`.
 */
export function padraoBuscaFeed(search: string): string | null {
  return ilikeContainsPattern(normalizar(search.trim()));
}

/* ─── Filtros da listagem (status · período · ordem) — todos aplicados no SERVIDOR ─── */

export type FiltroStatusFeed = 'todos' | 'rascunhos' | 'em_andamento' | 'faturados' | 'cancelados';
export type PeriodoFeed = 'tudo' | 'hoje' | '7d' | '30d';
export type OrdemFeed = 'recentes' | 'valor';

/**
 * Status que cada chip traz. `importado` (pedido criado direto no Omie — 5.560 na prod em
 * 2026-11-21) e `orcamento` NÃO entram em grupo nenhum: o estágio real deles não é sabido, e
 * chamá-los de "em andamento" fabricaria um dado. Aparecem em "Todos". Os de afiação (`orders`)
 * entram pelos nomes de `ORDER_STATUS` (`src/types`).
 */
export const STATUS_DO_FILTRO: Record<Exclude<FiltroStatusFeed, 'todos'>, readonly string[]> = {
  rascunhos: ['rascunho'],
  em_andamento: [
    'enviado', 'separacao',
    // afiação
    'pedido_recebido', 'aguardando_coleta', 'recebido_balcao', 'em_triagem', 'orcamento_enviado',
    'aprovado', 'em_afiacao', 'controle_qualidade', 'pronto_entrega', 'em_rota',
  ],
  faturados: ['faturado', 'entregue'],
  cancelados: ['cancelado'],
};

const FILTROS_STATUS: readonly FiltroStatusFeed[] = ['todos', 'rascunhos', 'em_andamento', 'faturados', 'cancelados'];
const PERIODOS: readonly PeriodoFeed[] = ['tudo', 'hoje', '7d', '30d'];
const ORDENS: readonly OrdemFeed[] = ['recentes', 'valor'];
export const ehFiltroStatus = (v: string): v is FiltroStatusFeed => (FILTROS_STATUS as readonly string[]).includes(v);
export const ehPeriodo = (v: string): v is PeriodoFeed => (PERIODOS as readonly string[]).includes(v);
export const ehOrdem = (v: string): v is OrdemFeed => (ORDENS as readonly string[]).includes(v);

const DIAS_ANTES: Record<Exclude<PeriodoFeed, 'tudo'>, number> = { hoje: 0, '7d': 6, '30d': 29 };

/**
 * Predicado do `.or()` que corta o feed no início do período pelo DIA CIVIL de `diaDoPedido`, ou
 * `null` em "tudo". "Hoje" = o dia local de hoje; "7 dias" = hoje e os 6 anteriores.
 *
 * Um corte só não serve: o pedido do wizard tem hora real e vale o dia LOCAL (corte = meia-noite
 * local), mas a data-pura do Omie (00:00Z/12:00Z) vale o dia UTC. Em São Paulo a meia-noite local
 * é 03:00Z, e um `gte` só nela perderia o pedido do Omie gravado às 00:00Z do 1º dia; cortar em
 * 00:00Z traria os do wizard das 21h às 24h da véspera. Por isso: `created_at >= meia-noite local`
 * OU `created_at` = um dos instantes de data-pura do 1º dia que caem ANTES desse corte.
 * Limite aceito: fuso a leste de UTC+12 incluiria a data-pura das 12:00Z da véspera.
 */
export function filtroDoPeriodo(periodo: PeriodoFeed, agora: Date = new Date()): string | null {
  if (periodo === 'tudo') return null;
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - DIAS_ANTES[periodo]);
  const clausulas = [`created_at.gte.${inicio.toISOString()}`];
  for (const hora of [0, 12]) {
    const puro = Date.UTC(inicio.getFullYear(), inicio.getMonth(), inicio.getDate(), hora);
    if (puro < inicio.getTime()) clausulas.push(`created_at.eq.${new Date(puro).toISOString()}`);
  }
  return orFilter(...clausulas);
}

const ORIGENS_FEED: readonly OrderFeedRow['origin'][] = ['sales', 'afiacao'];

/**
 * Borda da view `order_feed`: exige as colunas-chave (lança se vierem nulas — 0 em 31.955 linhas na
 * prod em 2026-10-20) e estreita `origin`. Antes um cast duplo para `OrderFeedRow[]` afirmava tudo.
 */
export function feedRowDaLinha(linha: LinhaOrderFeed): OrderFeedRow {
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
