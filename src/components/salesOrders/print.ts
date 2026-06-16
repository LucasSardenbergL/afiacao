// Impressão por pedido a partir da listagem de vendas.
// Reusa o MESMO cupom de /sales/print (buildPrintData + openPrintOrder) — layout idêntico.
import { buildPrintData } from '@/components/sales/print/buildPrintHtml';
import { openPrintOrder } from '@/components/OrderPrintLayout';
import type { CompanyFilter, OmiePayload, OrderItem, SalesOrderRow } from '@/components/sales/print/types';
import type { SalesOrder } from './types';

// Total da linha do item. Alguns pedidos (ex.: rascunho) gravam valor_total = 0
// no item embora o valor_unitario esteja preenchido — nesse caso calculamos
// quantidade × valor_unitário para não exibir/imprimir R$ 0,00.
export function itemTotal(item: {
  valor_total?: number | null;
  quantidade?: number | null;
  valor_unitario?: number | null;
}): number {
  return item.valor_total || (item.quantidade || 0) * (item.valor_unitario || 0);
}

// sales_orders.account → empresa do cupom. colacor_sc é a entidade Colacor S.C.
// (mesma chave 'afiacao' do companyMap em buildPrintData).
export function resolveCompanyForPrint(account?: string): CompanyFilter {
  if (account === 'colacor') return 'colacor';
  if (account === 'colacor_sc') return 'afiacao';
  return 'oben';
}

// Adapta o pedido da listagem para o shape do pipeline de impressão. Preserva o
// array de itens cru (codigo/unidade/tint vêm do jsonb em runtime) e injeta
// nome/documento do cliente, que não vivem na linha de sales_orders.
export function buildSalesOrderPrintRow(
  order: SalesOrder,
  customerName: string,
  customerDocument?: string,
): SalesOrderRow {
  return {
    id: order.id,
    customer_user_id: order.customer_user_id,
    // valor_total por item recalculado quando vem zerado (rascunhos).
    items: (order.items ?? []).map((it) => ({ ...it, valor_total: itemTotal(it) })) as unknown as OrderItem[],
    subtotal: order.subtotal ?? 0,
    total: order.total ?? 0,
    desconto: order.discount ?? 0,
    status: order.status,
    omie_numero_pedido: order.omie_numero_pedido,
    created_at: order.created_at,
    notes: order.notes,
    account: order.account,
    customer_name: customerName,
    customer_document: customerDocument || undefined,
    customer_phone: order.customer_phone ?? undefined,
    customer_address: order.customer_address ?? undefined,
    omie_payload: (order.omie_payload as OmiePayload | null) ?? undefined,
  };
}

// Abre a janela de impressão do cupom para um pedido de venda.
export function printSalesOrder(
  order: SalesOrder,
  customerName: string,
  customerDocument?: string,
  logos?: Record<string, string | null>,
): void {
  const company = resolveCompanyForPrint(order.account);
  const row = buildSalesOrderPrintRow(order, customerName, customerDocument);
  openPrintOrder(buildPrintData(row, company, logos));
}
