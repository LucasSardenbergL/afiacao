import { diaDoPedido, rotuloDiaPedido } from '@/lib/pedido/data-pedido';
import { BLOCKED_STATUSES } from '@/components/salesOrderEdit/types';
import { format } from 'date-fns';
// Tipos + constantes + helpers da listagem de pedidos de venda.
// Extraídos verbatim de src/pages/SalesOrders.tsx (god-component split).
import type { Tables } from '@/integrations/supabase/types';

export type SalesOrderRow = Tables<'sales_orders'>;
export type AfiacaoOrderRow = Tables<'orders'>;

// Shape de cada item dentro de orders.items (jsonb). Só os campos consumidos aqui.
export interface AfiacaoItemRaw {
  category?: string | null;
  name?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
}

// 3 empresas reais (oben, colacor, colacor_sc) + 'all'. Afiação NÃO é empresa,
// é um módulo operando sob Colacor SC — pedidos da tabela `orders` (afiação)
// aparecem dentro da aba "Colacor SC" junto com os pedidos comerciais
// `sales_orders WHERE account='colacor_sc'`. Cada card mantém badge "Afiação"
// quando _source='afiacao' pra preservar a distinção visual.
export type Account = 'oben' | 'colacor' | 'colacor_sc' | 'all';

export const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

// Item do pedido como o painel/impressão o leem do jsonb sales_orders.items (`itemDetalheDoJson`).
// Os campos extras (codigo/unidade/tint) só aparecem em alguns itens (ex.: bases tintométricas).
export type SalesOrderItem = {
  descricao: string;
  quantidade: number;
  /** `null` = preco NAO SABIDO (o Omie nao informou valor_unitario). Nunca R$ 0,00. */
  valor_unitario: number | null;
  /** Ausente na quase totalidade dos itens gravados (o total é derivado); `null` = sem preço, sem total. */
  valor_total?: number | null;
  codigo?: string;
  unidade?: string;
  tint_cor_id?: string;
  tint_nome_cor?: string;
};

export interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: SalesOrderItem[];
  subtotal: number;
  total: number;
  status: string;
  omie_numero_pedido: string | null;
  omie_pedido_id: number | null;
  created_at: string;
  notes: string | null;
  account?: string;
  _source?: 'sales' | 'afiacao';
  // Campos que o select('*') de sales_orders já traz em runtime — consumidos
  // pela impressão do pedido (buildSalesOrderPrintRow). Opcionais: os pedidos
  // de afiação (montados à mão no hook) não os têm.
  customer_address?: string | null;
  customer_phone?: string | null;
  omie_payload?: unknown;
  discount?: number;
}

// Linha da view order_feed (read model da listagem — migrations 20260606210000 e 20261101221452).
// Sem `busca`: a coluna só serve de filtro no servidor e a listagem não a baixa.
export type LinhaOrderFeed = Omit<Tables<'order_feed'>, 'busca'>;

/** Colunas sem as quais a linha do feed não faz sentido (view: o gerador as dá todas `| null`). */
export const COLUNAS_FEED_EXIGIDAS = [
  'origin', 'id', 'created_at', 'account', 'customer_user_id',
  'item_names', 'item_quantity', 'status', 'subtotal', 'total',
] as const satisfies readonly (keyof LinhaOrderFeed)[];

/** Linha da view `order_feed` com as colunas-chave exigidas e `origin` estreitado (`feedRowDaLinha`). */
export type OrderFeedRow = Omit<LinhaOrderFeed, (typeof COLUNAS_FEED_EXIGIDAS)[number]> & {
  [K in Exclude<(typeof COLUNAS_FEED_EXIGIDAS)[number], 'origin'>]: NonNullable<LinhaOrderFeed[K]>;
} & { origin: 'sales' | 'afiacao' };

// Uma página da listagem (useInfiniteQuery ['order-feed', userId, empresa, busca]). `count` só vem
// na 1ª página e só sem busca (o count da busca custaria um 2º scan dos ~32 k); `null` = não contado.
export interface PaginaFeed {
  rows: OrderFeedRow[];
  count: number | null;
  /**
   * Chave da ÚLTIMA linha como o servidor a devolveu — a próxima página começa depois dela (keyset).
   * Guardada na leitura, não derivada de `rows`: o optimistic da exclusão tira linhas da página, e o
   * cursor não pode andar para trás com ele. `null` = página vazia.
   */
  cursor: CursorFeed | null;
  /** A página veio cheia (FEED_PAGE_SIZE linhas lidas): pode haver mais. Também imune ao optimistic. */
  cheia: boolean;
}

/** Cursor do feed: as colunas da ordem (`total` só na ordem "Maior valor"), em texto exato do servidor. */
export interface CursorFeed {
  total: string | null;
  created_at: string;
  origin: string;
  id: string;
}

// Detalhe completo de um pedido, buscado por (origin, id) ao abrir o painel /
// imprimir / compartilhar. A listagem (view) é enxuta de propósito.
export interface OrderDetail {
  order: SalesOrder;
  customerName: string;
  customerDocument?: string;
}

export const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  rascunho: { label: 'Rascunho', variant: 'outline' },
  enviado: { label: 'Enviado ao Omie', variant: 'default' },
  // Status gravados pelo omie-vendas-sync (pedido criado direto no Omie ou
  // registro paralelo do sync) — sem entrada aqui caíam no fallback "Rascunho".
  importado: { label: 'Importado', variant: 'secondary' },
  separacao: { label: 'Em separação', variant: 'default' },
  faturado: { label: 'Faturado', variant: 'secondary' },
  cancelado: { label: 'Cancelado', variant: 'destructive' },
  recebido: { label: 'Recebido', variant: 'default' },
  em_analise: { label: 'Em Análise', variant: 'default' },
  em_producao: { label: 'Em Produção', variant: 'default' },
  pronto: { label: 'Pronto', variant: 'secondary' },
  entregue: { label: 'Entregue', variant: 'secondary' },
};

// Lookup com fallback HONESTO: status desconhecido exibe o próprio status
// (capitalizado, "_" → espaço), nunca finge ser "Rascunho" — um pedido já no
// Omie rotulado de rascunho induz a vendedora a erro.
export function statusDoPedido(status: string): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  const conhecido = statusLabels[status];
  if (conhecido) return conhecido;
  const cru = (status || '').replace(/_/g, ' ').trim();
  return {
    label: cru ? cru.charAt(0).toUpperCase() + cru.slice(1) : 'Sem status',
    variant: 'outline',
  };
}

/** Tom visual do status na listagem: cor só no que pede atenção; o resto fica neutro. */
export type TomStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral';

// warning = "pede ação de alguém da equipe": rascunho por enviar, afiação pronta esperando o cliente
// ser avisado / a retirada, coleta por agendar.
const TOM_DO_STATUS: Record<string, TomStatus> = {
  rascunho: 'warning',
  pronto: 'warning',
  pronto_entrega: 'warning',
  aguardando_coleta: 'warning',
  enviado: 'info',
  separacao: 'info',
  // afiação em curso (vocabulário de ORDER_STATUS)
  pedido_recebido: 'info',
  recebido_balcao: 'info',
  em_triagem: 'info',
  orcamento_enviado: 'info',
  aprovado: 'info',
  em_afiacao: 'info',
  controle_qualidade: 'info',
  em_rota: 'info',
  faturado: 'success',
  entregue: 'success',
  cancelado: 'error',
};

export function tomDoStatus(status: string): TomStatus {
  return TOM_DO_STATUS[status] ?? 'neutral';
}

/**
 * Rótulo da empresa do pedido. Conta desconhecida aparece como ela é — nunca vira "Oben" por
 * fallback (um pedido de outra empresa rotulado de Oben induz a vendedora a erro).
 */
export function rotuloEmpresa(account: string | null | undefined): string {
  switch (account) {
    case 'oben': return 'Oben';
    case 'colacor': return 'Colacor';
    case 'colacor_sc': return 'Colacor SC';
    default: return account ? account : '—';
  }
}

/**
 * Se a exclusão deste pedido tem chance de passar, e por que não. ESPELHO do contrato da edge
 * (`omie-vendas-sync` → `excluir_pedido` + `vereditoExclusaoNoOmie` em `_shared/atp-pv-omie.ts`),
 * que segue sendo a AUTORIDADE — aqui só se evita oferecer uma ação que a edge sempre recusa:
 *  - o app NÃO cancela nem exclui nada no Omie; só tira o registro do app;
 *  - só contas `oben` e `colacor` (Colacor SC é recusada);
 *  - registro importado do Omie nunca sai (o app espelha o Omie, inclusive os cancelados);
 *  - pedido do app que já está no Omie só sai depois que o cancelamento FEITO NO OMIE chegou pelo sync.
 */
/** Chave estável da linha (a MESMA do `key` React na listagem): o teclado e o retorno de foco a usam. */
export const chaveDaLinha = (o: Pick<OrderFeedRow, 'origin' | 'id'>) => `${o.origin}-${o.id}`;

export function podeExcluirPedido(
  order: Pick<OrderFeedRow, 'origin' | 'account' | 'status' | 'omie_pedido_id'>,
): { ok: true } | { ok: false; motivo: string } {
  if (order.origin !== 'sales') return { ok: false, motivo: 'Ordem de afiação não é excluída por aqui.' };
  if (order.account !== 'oben' && order.account !== 'colacor') {
    return { ok: false, motivo: `Pedidos da ${rotuloEmpresa(order.account)} não são excluídos pelo app.` };
  }
  if (order.status === 'importado') {
    return { ok: false, motivo: 'Importado do Omie: fica no app espelhando o Omie. Para cancelar, cancele no Omie.' };
  }
  if (order.omie_pedido_id != null && order.status !== 'cancelado') {
    return { ok: false, motivo: 'Já está no Omie: cancele lá primeiro; quando o cancelamento chegar pelo sync, a exclusão libera.' };
  }
  return { ok: true };
}

/** Texto honesto do que a exclusão faz (o app não mexe no Omie). */
export const EFEITO_DA_EXCLUSAO = 'O pedido sai do app. Nada é alterado no Omie.';

export interface GrupoDia {
  dia: string;
  rotulo: string;
  pedidos: OrderFeedRow[];
}

// Agrupa pela chave de DIA CIVIL, não por vizinhança: a lista vem por created_at DESC, mas a data-pura
// do Omie (meio-dia/meia-noite UTC = dia UTC) e a hora real do wizard (dia LOCAL) intercalam — em
// São Paulo, 21/11 12:00Z · 21/11 01:00Z · 21/11 00:00Z dá os dias 21, 20, 21, e o "só vizinhos"
// abria o 21 duas vezes (com chave React repetida). Grupos em ordem de dia DESC; "Sem data" no fim.
// Dentro do grupo a ordem do feed se mantém.
/** `hoje` (yyyy-MM-dd local) decide o rótulo "Hoje"/"Ontem"; quem memoiza passa o dia para o memo virar à meia-noite. */
export function agruparPorDia(pedidos: OrderFeedRow[], hoje?: string): GrupoDia[] {
  const porDia = new Map<string, OrderFeedRow[]>();
  for (const p of pedidos) {
    const dia = diaDoPedido(p.created_at) ?? 'sem-data';
    const lista = porDia.get(dia);
    if (lista) lista.push(p);
    else porDia.set(dia, [p]);
  }
  return [...porDia.entries()]
    .sort(([a], [b]) => (a === 'sem-data' ? 1 : b === 'sem-data' ? -1 : b.localeCompare(a)))
    .map(([dia, lista]) => ({ dia, rotulo: dia === 'sem-data' ? 'Sem data' : rotuloDiaPedido(dia, hoje), pedidos: lista }));
}

/**
 * Pedido de venda editável: a MESMA lista que a tela de edição usa para bloquear
 * (`BLOCKED_STATUSES`). Antes havia três cópias (card, painel, edição), e mudar uma só
 * deixava a lista oferecer "Editar" onde a edição recusa. Afiação não se edita por aqui.
 */
export function podeEditarPedido(order: { status: string; _source?: string; origin?: string }): boolean {
  if (order.origin === 'afiacao' || order._source === 'afiacao') return false;
  return !BLOCKED_STATUSES.includes(order.status);
}

const pedidos = (n: number) => `${n.toLocaleString('pt-BR')} ${n === 1 ? 'pedido' : 'pedidos'}`;

/** Toast do fim da exclusão em lote, com concordância (era "pedido(s) excluído(s)"). */
export function mensagemDoLote(sucesso: number, falhas: number): string {
  const excluidos = `${pedidos(sucesso)} ${sucesso === 1 ? 'excluído' : 'excluídos'}`;
  if (falhas === 0) return excluidos;
  const recusados = `${pedidos(falhas)} não ${falhas === 1 ? 'pôde' : 'puderam'} ser ${falhas === 1 ? 'excluído' : 'excluídos'}`;
  return sucesso === 0 ? recusados : `${excluidos}; ${recusados}`;
}

/**
 * Último dia que AINDA pode receber pedidos das próximas páginas. O feed vem por `created_at` DESC,
 * então todo pedido não carregado tem `created_at` ≤ o do último carregado (T). O dia dele é o local
 * ou, se for data-pura do Omie, o UTC — os dois nunca passam do maior entre o dia local e o UTC de T.
 * Um grupo com dia ESTRITAMENTE maior que esse está completo; os outros podem crescer.
 */
export function ultimoDiaAberto(ultimoCarregado: string): string | null {
  const d = new Date(ultimoCarregado);
  if (Number.isNaN(d.getTime())) return null;
  const local = format(d, 'yyyy-MM-dd');
  const utc = d.toISOString().slice(0, 10);
  return local > utc ? local : utc;
}

/**
 * Contagem do cabeçalho do dia ("12 pedidos"), ou `null` quando o grupo pode estar incompleto
 * (ainda há página e o dia não está garantidamente fechado): contagem parcial com cara de total
 * é número fabricado. Sem soma em R$ de propósito: o grupo mistura cancelado e afiação, e o valor
 * do recorte (servidor) já existe na barra de filtros.
 */
export function contagemDoDia(grupo: GrupoDia, temMaisPaginas: boolean, limiteAberto: string | null): string | null {
  if (temMaisPaginas && (grupo.dia === 'sem-data' || limiteAberto === null || grupo.dia <= limiteAberto)) return null;
  return pedidos(grupo.pedidos.length);
}
