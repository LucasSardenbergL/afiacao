// Data de exibição de pedido (sales_orders.created_at).
//
// Pedidos importados do Omie (omie-vendas-sync, sync_pedidos) têm created_at
// derivado de data_previsao — uma data PURA (DD/MM/YYYY, sem hora) que o sync
// grava como meia-noite UTC. Formatar esse timestamp com hora no fuso local
// fabrica "às 21:00" e escorrega o dia (10/06 00:00 UTC → 09/06 21:00 em BRT).
// Pedidos criados pelo wizard têm created_at real (now() do banco) e mantêm
// data + hora locais.
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// Meia-noite UTC exata = data-pura (o Omie não fornece hora). Um pedido do
// wizard criado exatamente em 00:00:00.000Z perderia a hora na exibição —
// 1 instante em 86,4 milhões por dia, aceitável.
export function ehDataPuraUtc(d: Date): boolean {
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

export function formatarDataPedido(
  createdAt: string,
  formatoComHora: string = "dd/MM/yyyy 'às' HH:mm",
): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '—';
  if (ehDataPuraUtc(d)) {
    const dia = String(d.getUTCDate()).padStart(2, '0');
    const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dia}/${mes}/${d.getUTCFullYear()}`;
  }
  return format(d, formatoComHora, { locale: ptBR });
}
