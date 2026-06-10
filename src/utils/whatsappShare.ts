interface OrderItem {
  description: string;
  quantity: number;
  unitPrice: number;
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
}

export function shareOrderViaWhatsApp({
  customerName,
  items,
  total,
  orderNumbers = [],
  date = new Date(),
}: ShareOrderParams) {
  const itemsList = items
    .map(
      (item) => {
        const tintInfo = item.tintCorId ? ` (Cor: ${item.tintCorId} — ${item.tintNomeCor})` : '';
        return `• ${item.quantity}x ${item.description}${tintInfo} - ${(item.quantity * item.unitPrice).toLocaleString(
          'pt-BR',
          { style: 'currency', currency: 'BRL' }
        )}`;
      }
    )
    .join('\n');

  const orderInfo = orderNumbers.length > 0 ? `\nPedido(s): ${orderNumbers.join(' + ')}` : '';

  const dateStr = typeof date === 'string'
    ? date
    : date.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

  const msg = `*Pedido Colacor*\n\nCliente: ${customerName}${orderInfo}\n\nItens:\n${itemsList}\n\n*Total: ${total.toLocaleString(
    'pt-BR',
    { style: 'currency', currency: 'BRL' }
  )}*\n\nData: ${dateStr}`;

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(whatsappUrl, '_blank');
}
