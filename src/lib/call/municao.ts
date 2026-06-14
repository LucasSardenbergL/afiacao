export interface MunicaoPedido {
  data: string;
  valor: number;
}

export interface MunicaoInput {
  pedidos: MunicaoPedido[];
  agora: Date;
}

export interface Municao {
  diasDesdeUltima: number | null;
  ultimaCompra: MunicaoPedido | null;
  ticketMedio: number | null;
}

/**
 * Munição read-only do co-piloto de ligação.
 * Ignora datas futuras (order_date_kpi pode vir adiantado pelo Omie).
 * Sem histórico válido → null honesto (nunca fabrica número).
 */
export function derivarMunicao({ pedidos, agora }: MunicaoInput): Municao {
  const hojeMs = agora.getTime();

  const validos = pedidos
    .filter((p) => {
      const t = new Date(p.data).getTime();
      return Number.isFinite(t) && t <= hojeMs;
    })
    .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());

  if (validos.length === 0) {
    return { diasDesdeUltima: null, ultimaCompra: null, ticketMedio: null };
  }

  const ultima = validos[0];

  return {
    diasDesdeUltima: Math.floor((hojeMs - new Date(ultima.data).getTime()) / 86_400_000),
    ultimaCompra: ultima,
    ticketMedio: Math.round(validos.reduce((s, p) => s + p.valor, 0) / validos.length),
  };
}
