// Tipos da tela de edição de pedido de venda.
// Extraídos verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import type { Tables } from '@/integrations/supabase/types';
import type { ItemPedidoJson, OmiePayloadJson } from '@/lib/pedido/itens-json';

/**
 * Item do pedido como vive no jsonb `sales_orders.items` — lido pela borda `itensPedidoDoJson`.
 * `valor_unitario` `null` = preço NÃO SABIDO: o guard de fronteira (invalidPricedOrderItemIndices)
 * já o trata como inválido e BLOQUEIA o salvar. Editar o `valor_unitario` de um item tint à mão limpa
 * os metadados `tint_*` de precificação (o item vira "legado" e o gate valida pelo piso).
 */
export type OrderItem = ItemPedidoJson;

export interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: OrderItem[];
  subtotal: number;
  total: number;
  status: string;
  notes: string | null;
  account: string;
  omie_pedido_id: number | null;
  omie_numero_pedido: string | null;
  omie_payload: OmiePayloadJson | null;
  created_at: string;
  /** Versão da linha na abertura (trigger em todo UPDATE) — trava otimista do salvar local. */
  updated_at?: string | null;
  /**
   * Pedido CRIADO no Omie e trazido pelo sync (`hash_payload` = `omie_<conta>_<pid>`, determinístico;
   * pedido do app tem `hash_payload` NULL). É fato de ORIGEM — o status muda com a etapa do Omie
   * ("importado" → "separacao"/"enviado"), a origem não. Opcional: ausente = não sabido = trata como
   * do app (o status ainda bloqueia o que já bloqueava).
   */
  origem_omie?: boolean;
}

/**
 * Resposta da action `listar_formas_pagamento`. `source`/`degraded`/`motivo` são ADITIVOS
 * (edge #1597) e opcionais: edge antiga — ou ainda não deployada — devolve só `formas`, e a
 * leitura em `@/services/orderSubmission/formasDegradacao` trata a ausência como NÃO-degradado.
 */
export interface FormasPagamentoResponse {
  formas?: Array<{ codigo: string; descricao: string }>;
  source?: string | null;
  degraded?: boolean | null;
  motivo?: string | null;
}

/** Linha do catálogo de edição (as colunas do select em `useSalesOrderEdit`). `estoque` NULL = não sincronizado. */
export type OmieProduct = Pick<
  Tables<'omie_products'>,
  | 'id' | 'omie_codigo_produto' | 'codigo' | 'descricao' | 'unidade' | 'valor_unitario' | 'estoque' | 'ativo'
  | 'account' | 'is_tintometric' | 'tint_type'
>;

/**
 * Status em que o app NÃO edita o pedido. `importado` = pedido criado direto no Omie por outra
 * pessoa: salvar aqui chamaria `alterar_pedido` e mudaria item/preço/prazo NO OMIE sem o dono saber
 * (decisão do founder, 2026-11-25). É o mesmo critério da exclusão: o app espelha, quem altera é o Omie.
 */
export const BLOCKED_STATUSES = ['cancelado', 'entregue', 'faturado', 'importado'];

/**
 * Por que a edição está travada, ou `null` se não está. Bloqueia por STATUS e por ORIGEM: um pedido
 * criado no Omie que avançou para "separacao" deixou de ser `importado`, mas continua sendo de outra
 * pessoa — salvar aqui faria `alterar_pedido` nele (Codex P0-5, 15 casos na prod em 2026-11-25).
 */
export function bloqueioDaEdicao(
  order: Pick<SalesOrder, 'status' | 'origem_omie'> & { account?: SalesOrder['account'] },
): string | null {
  if (order.origem_omie) return motivoEdicaoBloqueada('importado');
  if (order.account !== undefined && contaDaEdicao(order.account) === null) {
    return `A empresa deste pedido (${order.account || 'sem empresa'}) não é editável pelo app — catálogo e condições seriam de outra empresa. Altere no Omie.`;
  }
  return BLOCKED_STATUSES.includes(order.status) ? motivoEdicaoBloqueada(order.status) : null;
}

/**
 * Conta do pedido que a edição sabe tratar, ou `null`. Antes valia `colacor ? colacor : oben`: qualquer
 * outra conta (ex.: `colacor_sc`) abria com catálogo e condições da Oben (revisão /sales #4). Mesma regra
 * da edge (`vereditoPedidoLocalEdicao` → `conta_desconhecida`).
 */
export function contaDaEdicao(account: unknown): 'oben' | 'colacor' | null {
  return account === 'oben' || account === 'colacor' ? account : null;
}

/** Por que a edição está travada — o importado diz ONDE alterar, em vez de só "não pode". */
export function motivoEdicaoBloqueada(status: string): string {
  if (status === 'importado') return 'Pedido importado do Omie: o app só espelha. Para alterar, altere no Omie.';
  return `Este pedido está com status "${status}" e não pode ser editado.`;
}

/** #28: estado do catálogo "Adicionar produto" — separado das formas; falha ≠ catálogo vazio. */
export type EstadoCatalogo = 'carregando' | 'ok' | 'falhou';

/** #40: a carga do PEDIDO. `nao-encontrado` (a linha não existe) ≠ `falhou` (não consegui ler). */
export type CargaDoPedido =
  | { estado: 'carregando' }
  | { estado: 'ok' }
  | { estado: 'nao-encontrado' }
  | { estado: 'falhou'; erro: unknown };

/** Texto da falha de leitura do pedido na edição — mesma régua de `mensagemDoErroDaLista` (/sales). */
export function mensagemDaFalhaDoPedido(erro: unknown, online: boolean): string {
  if (!online) return 'Sem conexão com a internet.';
  if (erro instanceof Error && erro.name === 'LensReadOnlyError') {
    return 'A lente "Ver como" não permite esta leitura. Saia da lente para abrir o pedido.';
  }
  const codigo = typeof erro === 'object' && erro !== null && 'code' in erro ? String((erro as { code: unknown }).code) : '';
  if (codigo === '42501' || codigo === 'PGRST301' || codigo === '401' || codigo === '403') {
    return 'Seu acesso não permite ler este pedido. Se deveria, avise o suporte.';
  }
  if (codigo === 'PGRST002' || codigo.startsWith('5') || codigo === '57014') {
    return 'O servidor não respondeu. Tente de novo em instantes.';
  }
  return 'A leitura do pedido falhou. Tente de novo; se repetir, avise o suporte.';
}
