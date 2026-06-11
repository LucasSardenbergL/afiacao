// KPIs "faturado hoje/ontem" e "pedidos hoje" do cockpit de vendas (useVendasZone).
// Pedidos do sync Omie têm created_at data-pura (meia-noite UTC) e pedidos do wizard
// têm timestamp real — filtrar por janela de dia LOCAL joga o pedido do sync de hoje
// em "ontem" em BRT. A query usa a UNIÃO das janelas de ontem+hoje e o pertencimento
// é re-decidido por pedido via pedidoNoDiaCivil (cada pedido conta em exatamente 1 dia).
import { janelaQueryDiaCivil, pedidoNoDiaCivil } from '@/lib/pedido/dia-civil';

export interface PedidoVendasDia {
  created_at: string;
  total?: number | string | null;
}

export interface VendasPorDiaCivil {
  faturadoHoje: number;
  pedidosHoje: number;
  faturadoOntem: number;
}

function ontemDe(hoje: Date): Date {
  const ontem = new Date(hoje);
  ontem.setDate(ontem.getDate() - 1);
  return ontem;
}

/** Janela única de query cobrindo a união dos dias civis de ontem e de hoje. */
export function janelaQueryHojeOntem(hoje: Date): { inicioIso: string; fimIso: string } {
  const jHoje = janelaQueryDiaCivil(hoje);
  const jOntem = janelaQueryDiaCivil(ontemDe(hoje));
  return {
    inicioIso: jOntem.inicioIso <= jHoje.inicioIso ? jOntem.inicioIso : jHoje.inicioIso,
    fimIso: jHoje.fimIso >= jOntem.fimIso ? jHoje.fimIso : jOntem.fimIso,
  };
}

/**
 * Classifica cada pedido em exatamente um dia civil (hoje × ontem × fora) e agrega.
 * O else-if garante a exclusividade mesmo na borda em que a janela de query (união)
 * traz pedidos de dias vizinhos.
 */
export function agregarVendasPorDiaCivil(
  rows: PedidoVendasDia[],
  hoje: Date,
): VendasPorDiaCivil {
  const ontem = ontemDe(hoje);
  let faturadoHoje = 0;
  let pedidosHoje = 0;
  let faturadoOntem = 0;
  for (const r of rows) {
    if (pedidoNoDiaCivil(r.created_at, hoje)) {
      pedidosHoje += 1;
      faturadoHoje += Number(r.total ?? 0);
    } else if (pedidoNoDiaCivil(r.created_at, ontem)) {
      faturadoOntem += Number(r.total ?? 0);
    }
  }
  return { faturadoHoje, pedidosHoje, faturadoOntem };
}
