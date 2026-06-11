// Dia civil de um pedido (sales_orders/orders.created_at) — DOIS regimes coexistem:
// - sync Omie (omie-vendas-sync sync_pedidos): created_at é data PURA gravada como
//   meia-noite UTC (o Omie não fornece hora) → o dia civil correto é o dia UTC;
// - wizard/app: created_at real (now() do banco) → o dia civil é o dia LOCAL.
// Filtrar por janela local pura (startOfDay/endOfDay) joga o pedido do sync no dia
// anterior em BRT (10/06 00:00Z = 09/06 21:00 local). A solução: a QUERY usa a união
// das duas janelas e o pertencimento ao dia é re-decidido client-side por regime.
import { endOfDay, format, startOfDay } from 'date-fns';
import { ehDataPuraUtc } from './data-pedido';

/**
 * Janela [inicio, fim] pra query de created_at: união do dia civil LOCAL com o dia
 * civil UTC da data selecionada. Mais larga que cada regime sozinho — pode incluir
 * pedidos de dias vizinhos; quem decide o dia é `pedidoNoDiaCivil` (client-side).
 */
export function janelaQueryDiaCivil(dataSelecionada: Date): { inicioIso: string; fimIso: string } {
  const ano = dataSelecionada.getFullYear();
  const mes = dataSelecionada.getMonth();
  const dia = dataSelecionada.getDate();
  const inicioUtc = Date.UTC(ano, mes, dia, 0, 0, 0, 0);
  const fimUtc = Date.UTC(ano, mes, dia, 23, 59, 59, 999);
  return {
    inicioIso: new Date(Math.min(startOfDay(dataSelecionada).getTime(), inicioUtc)).toISOString(),
    fimIso: new Date(Math.max(endOfDay(dataSelecionada).getTime(), fimUtc)).toISOString(),
  };
}

/**
 * O pedido pertence ao dia civil da data selecionada? Data-pura (sync) compara o
 * calendário UTC; timestamp real (wizard) compara o calendário local. Cada pedido
 * pertence a exatamente UM dia — é o que evita duplicação na borda entre dias
 * adjacentes quando a janela de query (união) se sobrepõe.
 */
export function pedidoNoDiaCivil(createdAt: string, dataSelecionada: Date): boolean {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return false;
  if (ehDataPuraUtc(d)) {
    return (
      d.getUTCFullYear() === dataSelecionada.getFullYear() &&
      d.getUTCMonth() === dataSelecionada.getMonth() &&
      d.getUTCDate() === dataSelecionada.getDate()
    );
  }
  return (
    d.getFullYear() === dataSelecionada.getFullYear() &&
    d.getMonth() === dataSelecionada.getMonth() &&
    d.getDate() === dataSelecionada.getDate()
  );
}

/**
 * Hora pra exibição em lista: data-pura não tem hora real (HH:mm local fabricaria
 * "21:00" em BRT) → "—"; timestamp real mantém HH:mm local.
 */
export function horaExibicaoPedido(createdAt: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime()) || ehDataPuraUtc(d)) return '—';
  return format(d, 'HH:mm');
}
