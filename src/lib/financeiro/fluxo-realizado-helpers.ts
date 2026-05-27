// Fluxo de caixa REALIZADO derivado de fin_movimentacoes (não da baixa-do-título,
// que está sempre NULL — o Omie não manda no endpoint LIST). Caixa realizado é
// evento de movimento por dia. Exclui movimentos sem título (transferências/
// tarifas internas) pra não inflar o fluxo bruto operacional.

export type MovimentoRealizado = {
  data_movimento: string;
  tipo: string | null; // 'E' = entrada, 'S' = saída; null/outro = ignorado
  valor: number;
  omie_codigo_lancamento: number | null;
};

export type RealizadoDia = { entradas: number; saidas: number };

export function agregarRealizadoPorDia(movimentos: MovimentoRealizado[]): Map<string, RealizadoDia> {
  const map = new Map<string, RealizadoDia>();
  for (const m of movimentos) {
    if (!m.data_movimento) continue;
    if (m.omie_codigo_lancamento == null) continue; // exclui transferência/tarifa sem título
    const dia = map.get(m.data_movimento) ?? { entradas: 0, saidas: 0 };
    const valor = Math.abs(Number(m.valor) || 0);
    if (m.tipo === 'E') dia.entradas += valor;
    else if (m.tipo === 'S') dia.saidas += valor;
    map.set(m.data_movimento, dia);
  }
  return map;
}
