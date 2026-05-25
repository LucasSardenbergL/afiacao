// A4 — Próxima Melhor Ação. Módulo puro, espelhado verbatim na edge function Deno
// supabase/functions/fin-next-best-action/index.ts. Compõe A1/A2/A3 numa fila priorizada.

export function caixaDisponivel(input: {
  saldo_tesouraria: number;
  dias_cobertura: number;
  reserva_dias_min: number;
  confianca_baixa: boolean;
}): number {
  if (input.dias_cobertura <= 0) return 0; // cobertura desconhecida → conservador, reserva tudo
  const fracaoReserva = Math.min(1, input.reserva_dias_min / input.dias_cobertura);
  let disp = input.saldo_tesouraria * (1 - fracaoReserva);
  if (input.confianca_baixa) disp *= 0.5; // haircut quando a projeção de caixa é incerta
  return Math.max(0, disp);
}

export type FonteHurdle = 'wacc' | 'retorno_dono' | 'custo_divida' | 'mediana' | 'indisponivel';

export function hurdleEfetivo(input: {
  wacc: number | null;
  custo_divida_pos_imposto: number | null;
  retorno_minimo_dono: number | null;
  mediana_hurdles: number | null;
}): { hurdle: number | null; fonte: FonteHurdle } {
  if (input.wacc != null) return { hurdle: input.wacc, fonte: 'wacc' };
  if (input.retorno_minimo_dono != null) return { hurdle: input.retorno_minimo_dono, fonte: 'retorno_dono' };
  if (input.custo_divida_pos_imposto != null) return { hurdle: input.custo_divida_pos_imposto, fonte: 'custo_divida' };
  if (input.mediana_hurdles != null) return { hurdle: input.mediana_hurdles, fonte: 'mediana' };
  return { hurdle: null, fonte: 'indisponivel' };
}

export type StatusAcao = 'financiar_ja' | 'financiar_condicional' | 'consertar_antes' | 'falta_dado' | 'nao_financiar';
export type TipoAcao = 'consertar_valor' | 'liberar_caixa' | 'crescer' | 'benchmark';

export function classificarStatus(input: {
  tipo: TipoAcao;
  impacto_eva: number | null;
  spread_positivo: boolean | null;
  caixa_consumido: number | null;
  caixa_disponivel: number;
  hurdle: number | null;
  tem_dado: boolean;
}): StatusAcao {
  if (!input.tem_dado) return 'falta_dado';
  if (input.tipo === 'benchmark') return 'nao_financiar';
  // consertar valor / liberar caixa: fazer primeiro (custo de caixa ~0, gera valor/solta caixa)
  if (input.tipo === 'consertar_valor' || input.tipo === 'liberar_caixa') return 'consertar_antes';
  // crescer: precisa bater o hurdle (spread positivo) E ter custo de caixa estimado.
  if (input.tipo === 'crescer') {
    if (input.spread_positivo !== true) return 'nao_financiar';
    // Sem custo estimado (ex.: sleeve company-level ou "crescer" do cockpit sem ticket) → precisa
    // dimensionar antes de financiar. NÃO assume custo 0 (crescer consome caixa via NCG).
    if (input.caixa_consumido == null) return 'falta_dado';
    return input.caixa_consumido <= input.caixa_disponivel ? 'financiar_ja' : 'financiar_condicional';
  }
  return 'falta_dado';
}

export type AcaoCandidata = {
  empresa: string;
  descricao: string;
  tipo: TipoAcao;
  impacto_eva: number | null;
  caixa_consumido: number | null;
  payback_meses: number | null;
  spread_positivo: boolean | null;
  confianca: 'alta' | 'media' | 'baixa';
};
export type AcaoFila = AcaoCandidata & { hurdle: number | null; status: StatusAcao };
export type ProximaAcaoResult = {
  fila: AcaoFila[];
  caixa_por_empresa: Record<string, { disponivel: number; confianca: 'alta' | 'media' | 'baixa' }>;
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  gerado_em: string;
};

const PRIORIDADE_TIPO: Record<TipoAcao, number> = { consertar_valor: 0, liberar_caixa: 1, crescer: 2, benchmark: 3 };

export function montarFilaAcoes(input: {
  candidatos: AcaoCandidata[];
  caixaPorEmpresa: Record<string, { disponivel: number; confianca: 'alta' | 'media' | 'baixa' }>;
  hurdlePorEmpresa: Record<string, number>;
}): ProximaAcaoResult {
  const candidatos = [...input.candidatos];
  // benchmark sempre presente (o piso: se nada supera o hurdle, segura caixa / paga dívida / distribui)
  candidatos.push({ empresa: '—', descricao: 'Não fazer nada / pagar dívida / distribuir ao dono (benchmark do hurdle)', tipo: 'benchmark', impacto_eva: null, caixa_consumido: 0, payback_meses: null, spread_positivo: null, confianca: 'alta' });

  const fila: AcaoFila[] = candidatos.map((c) => {
    const hurdle = c.empresa in input.hurdlePorEmpresa ? input.hurdlePorEmpresa[c.empresa] : null;
    const caixaDisp = input.caixaPorEmpresa[c.empresa]?.disponivel ?? 0;
    // tem_dado: crescer precisa de hurdle + sinal de spread; consertar/liberar/benchmark sempre têm.
    const tem_dado = c.tipo === 'crescer' ? (hurdle != null && c.spread_positivo != null) : true;
    const status = classificarStatus({ tipo: c.tipo, impacto_eva: c.impacto_eva, spread_positivo: c.spread_positivo, caixa_consumido: c.caixa_consumido, caixa_disponivel: caixaDisp, hurdle, tem_dado });
    return { ...c, hurdle, status };
  });

  // Ordena: por prioridade de tipo; dentro do tipo, sem-caixa antes; depois EVA/caixa desc; payback asc.
  fila.sort((a, b) => {
    if (PRIORIDADE_TIPO[a.tipo] !== PRIORIDADE_TIPO[b.tipo]) return PRIORIDADE_TIPO[a.tipo] - PRIORIDADE_TIPO[b.tipo];
    const semCaixaA = (a.caixa_consumido ?? 0) === 0 ? 0 : 1;
    const semCaixaB = (b.caixa_consumido ?? 0) === 0 ? 0 : 1;
    if (semCaixaA !== semCaixaB) return semCaixaA - semCaixaB;
    const ratioA = a.caixa_consumido && a.caixa_consumido > 0 ? (a.impacto_eva ?? 0) / a.caixa_consumido : Infinity;
    const ratioB = b.caixa_consumido && b.caixa_consumido > 0 ? (b.impacto_eva ?? 0) / b.caixa_consumido : Infinity;
    if (ratioA !== ratioB) return ratioB - ratioA;
    return (a.payback_meses ?? Infinity) - (b.payback_meses ?? Infinity);
  });

  // Confiança da fila: pior sinal entre caixa/candidatos.
  const motivos: string[] = [];
  let nivel: 'alta' | 'media' | 'baixa' = 'alta';
  const rebaixa = (n: 'media' | 'baixa', m: string) => { if (n === 'baixa' || nivel === 'alta') nivel = n; motivos.push(m); };
  if (fila.some((a) => a.status === 'falta_dado')) rebaixa('media', 'Algumas ações sem hurdle/cockpit (Falta dado).');
  if (Object.values(input.caixaPorEmpresa).some((c) => c.confianca === 'baixa')) rebaixa('baixa', 'Projeção de caixa de alguma empresa com confiança baixa.');

  return { fila, caixa_por_empresa: input.caixaPorEmpresa, confianca: { nivel, motivos }, gerado_em: new Date().toISOString() };
}
