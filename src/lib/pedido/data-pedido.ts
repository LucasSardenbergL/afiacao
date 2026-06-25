// Data de exibição de pedido (sales_orders.created_at).
//
// Pedidos importados do Omie (omie-vendas-sync, sync_pedidos) têm created_at = data PURA
// do pedido (DD/MM/YYYY, sem hora): o sync de recência (20260624170000) grava como MEIO-DIA
// UTC (= order_date_kpi às 12:00Z, timezone-safe p/ created_at::date bater em UTC e SP);
// pedidos legados/pré-backfill estão em meia-noite UTC (data_previsao). Formatar esse
// timestamp com hora no fuso local fabricaria hora falsa ("às 09:00"/"às 21:00") e escorrega
// o dia → ehDataPuraUtc trata AMBOS como data-pura. Pedidos do wizard têm created_at real
// (now() do banco) e mantêm data + hora locais.
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// Data-pura do Omie (sem hora real) = meia-noite UTC (legado: created_at de data_previsao
// como 00:00Z) OU meio-dia UTC (sync de recência 20260624170000: order_date_kpi às 12:00Z).
// Um pedido do wizard criado EXATAMENTE em 00:00:00.000Z ou 12:00:00.000Z perderia a hora —
// 2 instantes em 86,4 milhões por dia, aceitável.
export function ehDataPuraUtc(d: Date): boolean {
  const h = d.getUTCHours();
  return (
    (h === 0 || h === 12) &&
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
