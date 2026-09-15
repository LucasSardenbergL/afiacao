import { formatPrecoOuAusente, totalLinhaOuAusente } from '@/lib/format';

interface OrderItem {
  description: string;
  quantity: number;
  /** `null` = preco NAO SABIDO (o Omie nao informou). Vai "-" na mensagem, nunca R$ 0,00. */
  unitPrice: number | null;
  /**
   * Total da linha JÁ CALCULADO por quem chama — p.ex. o líquido do desconto de item. Ausente =
   * quantidade × preço, como sempre. `null` = não sabido: sai "—", nunca a conta bruta nem R$ 0,00.
   */
  lineTotal?: number | null;
  tintCorId?: string;
  tintNomeCor?: string;
}

interface ShareOrderParams {
  customerName: string;
  items: OrderItem[];
  total: number;
  orderNumbers?: string[];
  /** Date = formata data+hora no fuso local; string = já formatada pelo caller
   *  (ex.: formatarDataPedido, que omite a hora fabricada de pedido do sync). */
  date?: Date | string;
  /**
   * Quebra do desconto de item, JÁ CONFERIDA por quem chama (Subtotal − Desconto = Total, em
   * centavos): a mensagem ganha Subtotal e Desconto antes do Total, com os rótulos do cupom impresso.
   * Ausente = a mensagem de sempre. Este módulo não confere conta nenhuma — escreve a que recebeu.
   */
  quebraDesconto?: { subtotalBruto: number; descontoTotal: number; itensApurados: number };
}

export function shareOrderViaWhatsApp({
  customerName,
  items,
  total,
  orderNumbers = [],
  date = new Date(),
  quebraDesconto,
}: ShareOrderParams) {
  const itemsList = items
    .map(
      (item) => {
        const tintInfo = item.tintCorId ? ` (Cor: ${item.tintCorId} — ${item.tintNomeCor})` : '';
        // `quantity * unitPrice` com unitPrice null da 0 em JavaScript — a linha sairia como
        // "R$ 0,00" numa mensagem que vai PARA O CLIENTE, afirmando preco que ninguem apurou.
        // `lineTotal` null também não cai na conta bruta: é "não sei o líquido", e sai "—".
        const totalLinha =
          item.lineTotal !== undefined ? item.lineTotal : totalLinhaOuAusente(item.quantity, item.unitPrice);
        return `• ${item.quantity}x ${item.description}${tintInfo} - ${formatPrecoOuAusente(totalLinha)}`;
      }
    )
    .join('\n');

  const orderInfo = orderNumbers.length > 0 ? `\nPedido(s): ${orderNumbers.join(' + ')}` : '';

  // Com item de desconto não apurado, o rótulo diz quantos entraram na soma — como no cupom.
  const descontoParcial = quebraDesconto && quebraDesconto.itensApurados < items.length
    ? ` (${quebraDesconto.itensApurados} de ${items.length} itens)`
    : '';
  const descontoInfo = quebraDesconto
    ? `Subtotal: ${formatPrecoOuAusente(quebraDesconto.subtotalBruto)}\n` +
      `Desconto${descontoParcial}: - ${formatPrecoOuAusente(quebraDesconto.descontoTotal)}\n`
    : '';

  const dateStr = typeof date === 'string'
    ? date
    : date.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

  const msg = `*Pedido Colacor*\n\nCliente: ${customerName}${orderInfo}\n\nItens:\n${itemsList}\n\n${descontoInfo}*Total: ${total.toLocaleString(
    'pt-BR',
    { style: 'currency', currency: 'BRL' }
  )}*\n\nData: ${dateStr}`;

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(whatsappUrl, '_blank');
}
