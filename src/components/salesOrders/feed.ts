// Helpers puros da listagem unificada de pedidos (view order_feed).
// padraoBuscaFeed: o termo da busca como o servidor o compara com a coluna `busca` (a busca alcança
// os ~32 k pedidos, não só as páginas baixadas).
// mapSalesDetail/mapAfiacaoDetail: normalizam a linha crua do detalhe (select('*')
// de sales_orders | orders) pro shape SalesOrder que painel/impressão/share consomem.
import type { Json } from '@/integrations/supabase/types';
import { exigirColunas } from '@/lib/linha-view';
import { filtroKeysetApos, grupoAnd, grupoOr, ilikeContainsPattern, orFilter, sanitizeIlikeTerm } from '@/lib/postgrest';
import {
  COLUNAS_FEED_EXIGIDAS,
  type CursorFeed,
  type AfiacaoItemRaw,
  type LinhaOrderFeed,
  type AfiacaoOrderRow,
  type OrderFeedRow,
  type SalesOrder,
  type SalesOrderItem,
  type SalesOrderRow,
} from './types';
import { totalLinhaOuAusente, precoUtilizavel } from '@/lib/format';
import { totalDaLinha } from '@/lib/centavos';

/** Total da linha ao centavo no produto exato; preço ausente segue ausente (nunca R$ 0,00). */
function linhaExataOuAusente(quantidade: number, preco: number | null): number | null {
  const bruto = totalLinhaOuAusente(quantidade, preco);
  return bruto === null || preco === null ? null : totalDaLinha(quantidade, preco);
}

// Normaliza pra busca: minúsculas + sem diacríticos ("afiacao" acha "Afiação").
const normalizar = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Colunas que a listagem baixa — todas as da view MENOS `busca`, que só serve de filtro no servidor.
 * O `select` tipado do supabase-js deriva daqui o tipo da linha (`LinhaOrderFeed`).
 */
const COLUNAS_LISTAGEM_FEED =
  'origin,id,created_at,account,order_number,omie_pedido_id,customer_user_id,customer_name,item_names,item_quantity,status,subtotal,total' as const;

/**
 * Padrão do `.ilike('busca', …)` da listagem, ou `null` quando não há o que buscar.
 * A coluna `busca` da view (migration 20261101221452) já vem em minúsculas e sem acento, com o nome
 * do cliente (entidades HTML decodificadas), o nº do pedido, os itens e o total em "250.50" e
 * "250,50" — por isso basta normalizar o termo do mesmo jeito: "afiacao" acha "Afiação", "250,5"
 * acha o total 250.50. Os curingas do usuário (`%`, `_`, `*`) saem em `ilikeContainsPattern`.
 */
export function padraoBuscaFeed(search: string): string | null {
  const termo = termoBuscaFeed(search);
  return termo ? ilikeContainsPattern(termo) : null;
}

/**
 * O TERMO da busca (normalizado, sem `%`/`_`/`*` e sem `\`), ou `null` quando não sobra nada útil.
 * A lista usa `%termo%` (`padraoBuscaFeed`); a RPC do valor recebe o termo e monta o MESMO padrão com
 * `private.padrao_like_contem(termo) ESCAPE '\'`. Sem metacaractere no termo, os dois são idênticos —
 * o `\` sai porque o PostgREST o leria como escape e o helper, como literal.
 */
export function termoBuscaFeed(search: string): string | null {
  const termo = sanitizeIlikeTerm(normalizar(search.trim())).replace(/\\/g, '');
  return termo.trim() ? termo : null;
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
const STATUS_DO_FILTRO: Record<Exclude<FiltroStatusFeed, 'todos'>, readonly string[]> = {
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
  return orDoCorte(corteDoPeriodo(periodo, agora));
}

/**
 * O corte do período ESTRUTURADO: `created_at >= desde` OU `created_at` = um dos `puros` (ISO com
 * `Z`). É daqui que saem os DOIS consumidores — o `.or()` da listagem (`orDoCorte`) e os parâmetros
 * da RPC do valor do recorte (`paramsTotalDoRecorte`): calculado uma vez, nos mesmos instantes.
 */
export interface CortePeriodo {
  desde: string;
  puros: string[];
}

export function corteDoPeriodo(periodo: PeriodoFeed, agora: Date = new Date()): CortePeriodo | null {
  if (periodo === 'tudo') return null;
  const inicio = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - DIAS_ANTES[periodo]);
  const puros: string[] = [];
  for (const hora of [0, 12]) {
    const puro = Date.UTC(inicio.getFullYear(), inicio.getMonth(), inicio.getDate(), hora);
    if (puro < inicio.getTime()) puros.push(new Date(puro).toISOString());
  }
  return { desde: inicio.toISOString(), puros };
}

export function orDoCorte(corte: CortePeriodo | null): string | null {
  if (!corte) return null;
  return orFilter(`created_at.gte.${corte.desde}`, ...corte.puros.map((p) => `created_at.eq.${p}`));
}

/* ─── Recorte da listagem: UMA fonte para a página e para o valor do recorte ─── */

/**
 * Tudo o que decide QUAIS pedidos a listagem mostra (a ordem e o cursor decidem só a página).
 * `vendedor` = "Meus pedidos" (o usuário EFETIVO da lente); `null` = todos.
 */
export interface RecorteFeed {
  empresa: 'all' | 'oben' | 'colacor' | 'colacor_sc';
  status: FiltroStatusFeed;
  corte: CortePeriodo | null;
  cliente: string | null;
  /** O TERMO de `termoBuscaFeed` (sem curinga), ou `null` sem busca. */
  busca: string | null;
  vendedor: string | null;
}

/** Os filtros de igualdade/lista/ilike, como a listagem os aplica — o período vai no `.or()`. */
export type FiltroRecorte =
  | { op: 'eq'; coluna: 'account' | 'status' | 'customer_user_id'; valor: string }
  | { op: 'in'; coluna: 'status'; valores: readonly string[] }
  | { op: 'ilike'; coluna: 'busca'; padrao: string };

export function filtrosDoRecorte(r: RecorteFeed): FiltroRecorte[] {
  const f: FiltroRecorte[] = [];
  if (r.empresa !== 'all') f.push({ op: 'eq', coluna: 'account', valor: r.empresa });
  if (r.cliente) f.push({ op: 'eq', coluna: 'customer_user_id', valor: r.cliente });
  const padrao = r.busca ? ilikeContainsPattern(r.busca) : null;
  if (padrao) f.push({ op: 'ilike', coluna: 'busca', padrao });
  if (r.status === 'rascunhos') f.push({ op: 'eq', coluna: 'status', valor: 'rascunho' });
  else if (r.status !== 'todos') f.push({ op: 'in', coluna: 'status', valores: STATUS_DO_FILTRO[r.status] });
  return f;
}

/**
 * Parâmetros de `order_feed_total` para o MESMO recorte. Cada um espelha 1:1 um filtro da
 * listagem (migration 20261123120000; a paridade SQL é provada em db/test-order-feed-vendedor-total.sh).
 * "Todos" vai como `null` — `= ANY('{}')` não acharia linha nenhuma.
 */
export function paramsTotalDoRecorte(r: RecorteFeed) {
  return {
    p_account: r.empresa === 'all' ? null : r.empresa,
    p_status: r.status === 'todos' ? null : [...STATUS_DO_FILTRO[r.status]],
    p_desde: r.corte?.desde ?? null,
    p_puros: r.corte ? [...r.corte.puros] : null,
    p_customer: r.cliente,
    p_busca: r.busca,
    p_vendedor: r.vendedor,
  };
}

/** Leitura do valor do recorte — ausente nunca vira 0. */
export type ValorRecorte =
  | { estado: 'carregando' }
  | { estado: 'erro' }
  | { estado: 'ok'; pedidos: number; soma: number | null; semTotal: number };

/**
 * O texto do valor do recorte. Ausente é "—", nunca "R$ 0,00": recorte vazio ("0 pedidos · —"),
 * todos sem valor, carregando e erro. Soma com pedidos fora dela sai marcada como PARCIAL.
 */
export function textoValorRecorte(v: ValorRecorte, formatar: (n: number | null) => string): {
  valor: string;
  detalhe: string | null;
} {
  if (v.estado !== 'ok') return { valor: '—', detalhe: v.estado === 'erro' ? 'não consegui calcular' : null };
  const n = (x: number) => x.toLocaleString('pt-BR');
  const pedidos = `${n(v.pedidos)} ${v.pedidos === 1 ? 'pedido' : 'pedidos'}`;
  if (v.soma === null) return { valor: '—', detalhe: v.pedidos === 0 ? pedidos : `${pedidos} sem valor` };
  if (v.semTotal > 0) {
    return { valor: `${formatar(v.soma)} parcial`, detalhe: `${pedidos} · ${n(v.semTotal)} sem valor fora da soma` };
  }
  return { valor: formatar(v.soma), detalhe: pedidos };
}

/** Resposta crua da RPC → `ValorRecorte`. Forma inesperada LANÇA (vira estado de erro, nunca 0). */
export function valorDaResposta(data: unknown): Extract<ValorRecorte, { estado: 'ok' }> {
  const linha = Array.isArray(data) ? data[0] : data;
  if (typeof linha !== 'object' || linha === null) throw new Error('order_feed_total: resposta sem linha');
  const { pedidos, soma, sem_total } = linha as Record<string, unknown>;
  const inteiro = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const p = inteiro(pedidos);
  const s = inteiro(sem_total);
  if (p === null || s === null || !(soma === null || (typeof soma === 'number' && Number.isFinite(soma)))) {
    throw new Error('order_feed_total: resposta fora da forma {pedidos, soma, sem_total}');
  }
  return { estado: 'ok', pedidos: p, soma: soma as number | null, semTotal: s };
}

/**
 * Colunas de UMA página: as da listagem + o `total` em TEXTO, só para o cursor da ordem "Maior valor".
 * O `total` é `numeric` com até 14 casas na prod (18 caracteres): como número JS ele perde precisão,
 * e um cursor arredondado pularia ou repetiria os pedidos empatados no valor.
 */
export const COLUNAS_PAGINA_FEED = `${COLUNAS_LISTAGEM_FEED},total_cursor:total::text` as const;

/** Cursor da última linha lida (texto exato do servidor), ou `null` em página vazia. */
export function cursorDaPagina(
  linhas: readonly { origin: string | null; id: string | null; created_at: string | null; total_cursor: string | null }[],
): CursorFeed | null {
  const u = linhas[linhas.length - 1];
  if (!u) return null;
  // As 3 da ordem estável são exigidas (feedRowDaLinha já lança antes); o total pode faltar.
  if (!u.origin || !u.id || !u.created_at) throw new Error('order_feed: linha sem a chave do cursor');
  return { total: u.total_cursor, created_at: u.created_at, origin: u.origin, id: u.id };
}

/**
 * Predicado do `.or()` de uma página: o corte do período e/ou o "depois do cursor" (keyset), na
 * MESMA ordem dos `.order()` da consulta — `[total DESC NULLS LAST,] created_at DESC, origin, id`.
 * `null` = nada a filtrar. Os dois juntos vão num `and(…)` só: um `.or()` por vez na query.
 */
export function filtroDaPaginaFeed(
  cursor: CursorFeed | null,
  ordem: OrdemFeed,
  cortePeriodo: string | null,
): string | null {
  if (!cursor) return cortePeriodo;
  const estavel = [
    { coluna: 'created_at', ascendente: false, valor: cursor.created_at },
    { coluna: 'origin', ascendente: true, valor: cursor.origin },
    { coluna: 'id', ascendente: true, valor: cursor.id },
  ];
  const keyset = filtroKeysetApos(
    ordem === 'valor' ? [{ coluna: 'total', ascendente: false, valor: cursor.total, anulavel: true }, ...estavel] : estavel,
  );
  return cortePeriodo ? orFilter(grupoAnd(grupoOr(cortePeriodo), keyset)) : orFilter(keyset);
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

// Dedupe por (origin, id) preservando a 1ª ocorrência. Defesa em profundidade: com o cursor
// (keyset) uma linha só se repete se ela MUDAR de posição na ordem entre duas páginas (ex.: o
// `total` editado na ordem "Maior valor") — duplicata quebraria as keys do React.
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
      // Linha no produto EXATO, como a OS foi gravada (PR 2.4): o float de q × v dava R$ 30,22 numa OS
      // de R$ 30,23 (3 × 10,075 — Codex #4164, rodada 4).
      valor_total: linhaExataOuAusente(i.quantity ?? 1, precoUtilizavel(i.unitPrice)),
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
