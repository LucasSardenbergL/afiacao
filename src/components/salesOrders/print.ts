// Impressão por pedido a partir da listagem de vendas.
// Reusa o MESMO cupom de /sales/print (buildPrintData + openPrintOrder) — layout idêntico.
import { buildPrintData } from '@/components/sales/print/buildPrintHtml';
import { openPrintOrder } from '@/components/OrderPrintLayout';
import type { LeituraDescontosItens } from '@/components/sales/print/descontoCupom';
import type { CompanyFilter, OmiePayload, SalesOrderRow } from '@/components/sales/print/types';
import type { SalesOrder } from './types';
import { totalLinhaOuAusente } from '@/lib/format';

// Total da linha do item. Alguns pedidos (ex.: rascunho) gravam valor_total = 0
// no item embora o valor_unitario esteja preenchido — nesse caso calculamos
// quantidade × valor_unitário, ou `null` quando o preço é NÃO SABIDO.
//
// Era `valor_total || (quantidade || 0) * (valor_unitario || 0)`, que devolvia `0` para item sem
// preço e imprimia "R$ 0,00" no cupom do cliente — o mesmo byte para "de graça" e "não sei".
// Agora a ausência atravessa como `null` e a tela mostra "—" (formatPrecoOuAusente).
// `valor_total` continua tendo precedência quando existe: é o total que o Omie já apurou.
export function itemTotal(item: {
  valor_total?: number | null;
  quantidade?: number | null;
  valor_unitario?: number | null;
}): number | null {
  // `if (item.valor_total)` e nao `!== null`: o `||` original tratava 0 como "AINDA NAO
  // CALCULADO" e caia no fallback — e um rascunho chega com valor_total 0 e preco unitario
  // preenchido. Trocar isso por um teste de nulidade devolvia 0 para o rascunho e apagava
  // o total da tela e do cupom (pego pelo challenge do Codex; ha teste que fixa o caso).
  if (item.valor_total) return item.valor_total;
  return totalLinhaOuAusente(item.quantidade, item.valor_unitario);
}

// sales_orders.account → empresa do DOCUMENTO (cupom e mensagem de WhatsApp). colacor_sc é a entidade
// Colacor S.C. (chave 'afiacao' do companyMap em buildPrintData).
//
// Conta desconhecida → `null`, nunca Oben (revisão /sales #24/#26): antes qualquer outra conta caía em
// Oben e o cupom saía com o CNPJ e o endereço da Oben para um pedido de outra empresa. Mesma regra de
// `contaDaEdicao` na edição e de `rotuloEmpresa` na lista.
export function empresaDoDocumento(account: unknown): { cupom: CompanyFilter; nome: string } | null {
  if (account === 'oben') return { cupom: 'oben', nome: 'Oben' };
  if (account === 'colacor') return { cupom: 'colacor', nome: 'Colacor' };
  if (account === 'colacor_sc') return { cupom: 'afiacao', nome: 'Colacor SC' };
  return null;
}

export function resolveCompanyForPrint(account: unknown): CompanyFilter | null {
  return empresaDoDocumento(account)?.cupom ?? null;
}

/**
 * Por que este pedido NÃO pode virar documento para o cliente (cupom ou WhatsApp), ou `null`.
 * Itens ilegíveis (jsonb que não é lista, #27) não são "sem itens": o documento sairia vazio sob um
 * total positivo. Conta desconhecida não sai como outra empresa.
 */
export function motivoSemDocumento(order: Pick<SalesOrder, 'account' | 'itensIlegiveis'>): string | null {
  if (order.itensIlegiveis) return 'Não foi possível ler os itens deste pedido — o documento sairia incompleto.';
  if (empresaDoDocumento(order.account) === null) {
    return `A empresa deste pedido não é reconhecida (conta "${order.account ?? 'vazia'}") — o documento não sai como outra empresa.`;
  }
  return null;
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
    items: (order.items ?? []).map((it) => ({ ...it, valor_total: itemTotal(it) })),
    // Sem `?? 0`: `sales_orders.subtotal/total` são NOT NULL (o tipo já é `number`).
    subtotal: order.subtotal,
    total: order.total,
    // Sem `?? 0` (#26): desconto do cabeçalho ausente atravessa ausente; o cupom só mostra a linha > 0.
    desconto: order.discount ?? undefined,
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

// Abre a janela de impressão do cupom para um pedido de venda. Devolve o aviso do desconto de item
// para a TELA mostrar — o cupom saiu sem a quebra de um desconto que existe ou que não se leu — ou
// `null`. O aviso nunca vai ao papel.
export function printSalesOrder(
  order: SalesOrder,
  customerName: string,
  customerDocument: string | undefined,
  logos: Record<string, string | null> | undefined,
  descontos: LeituraDescontosItens,
): string | null {
  // Fail-closed: quem chama confere `motivoSemDocumento` antes e avisa a tela; chegar aqui com o
  // pedido recusado é bug, e o cupom não abre com outra empresa nem com itens que não se leram.
  const motivo = motivoSemDocumento(order);
  const company = resolveCompanyForPrint(order.account);
  if (motivo !== null || company === null) throw new Error(motivo ?? 'empresa do pedido não reconhecida');
  const row = buildSalesOrderPrintRow(order, customerName, customerDocument);
  const data = buildPrintData(row, company, logos, descontos);
  openPrintOrder(data);
  return data.avisoDesconto ?? null;
}
