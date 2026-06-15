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
  // hurdle ≤0 é implausível (custo de capital nunca é não-positivo) → trata como ausente e pula pro próximo
  // fallback. Coerente com os guards do A2/A3 ("soma ≤0 = capital grátis → null"). "ausente ≠ R$0".
  const ok = (x: number | null): x is number => x != null && Number.isFinite(x) && x > 0;
  if (ok(input.wacc)) return { hurdle: input.wacc, fonte: 'wacc' };
  if (ok(input.retorno_minimo_dono)) return { hurdle: input.retorno_minimo_dono, fonte: 'retorno_dono' };
  if (ok(input.custo_divida_pos_imposto)) return { hurdle: input.custo_divida_pos_imposto, fonte: 'custo_divida' };
  if (ok(input.mediana_hurdles)) return { hurdle: input.mediana_hurdles, fonte: 'mediana' };
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
    // dimensionar antes de financiar. NÃO assume custo 0/negativo: crescer SEMPRE consome caixa via
    // NCG, então custo ≤0 é dado implausível, não "grátis". "ausente ≠ R$0".
    if (input.caixa_consumido == null || input.caixa_consumido <= 0) return 'falta_dado';
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
    // A edge passa o WACC cru (não chama hurdleEfetivo) → a defesa contra hurdle ≤0 tem de estar aqui:
    // hurdle implausível (≤0) é tratado como ausente → crescer cai em falta_dado (não financia no escuro).
    const hurdleRaw = c.empresa in input.hurdlePorEmpresa ? input.hurdlePorEmpresa[c.empresa] : null;
    const hurdle = hurdleRaw != null && Number.isFinite(hurdleRaw) && hurdleRaw > 0 ? hurdleRaw : null;
    const caixaDisp = input.caixaPorEmpresa[c.empresa]?.disponivel ?? 0;
    // tem_dado: crescer precisa de hurdle + sinal de spread; consertar/liberar/benchmark sempre têm.
    const tem_dado = c.tipo === 'crescer' ? (hurdle != null && c.spread_positivo != null) : true;
    const status = classificarStatus({ tipo: c.tipo, impacto_eva: c.impacto_eva, spread_positivo: c.spread_positivo, caixa_consumido: c.caixa_consumido, caixa_disponivel: caixaDisp, hurdle, tem_dado });
    return { ...c, hurdle, status };
  });

  // Ordena: por prioridade de tipo; dentro do tipo, por bucket de custo; depois EVA/caixa desc; payback asc.
  // "ausente ≠ R$0": custo null NÃO é tratado como grátis (0) e EVA null NÃO vira ratio 0 — ambos vão
  // para o fim do seu critério em vez de fabricar um número que reordenaria a fila.
  fila.sort((a, b) => {
    if (PRIORIDADE_TIPO[a.tipo] !== PRIORIDADE_TIPO[b.tipo]) return PRIORIDADE_TIPO[a.tipo] - PRIORIDADE_TIPO[b.tipo];
    // bucket de custo: 0 = grátis genuíno (preço/prazo, "retorno infinito" — vem primeiro) · 1 = dimensionado
    // (caixa>0) · 2 = custo ausente/inválido (null/≤0 — desconhecido, vai por último; ausente ≠ grátis).
    const custoBucket = (x: AcaoFila) => x.caixa_consumido === 0 ? 0 : (x.caixa_consumido != null && x.caixa_consumido > 0 ? 1 : 2);
    const cbA = custoBucket(a), cbB = custoBucket(b);
    if (cbA !== cbB) return cbA - cbB;
    // ratio EVA/caixa (desc) só para dimensionados COM eva conhecido; sem ratio (null) → depois do que tem.
    const ratio = (x: AcaoFila) => x.caixa_consumido != null && x.caixa_consumido > 0 && x.impacto_eva != null ? x.impacto_eva / x.caixa_consumido : null;
    const rA = ratio(a), rB = ratio(b);
    if (rA != null && rB != null) { if (rA !== rB) return rB - rA; }
    else if (rA != null) return -1;
    else if (rB != null) return 1;
    return (a.payback_meses ?? Infinity) - (b.payback_meses ?? Infinity);
  });

  // Confiança da fila: pior sinal entre caixa/candidatos.
  const motivos: string[] = [];
  let nivel: 'alta' | 'media' | 'baixa' = 'alta';
  const rebaixa = (n: 'media' | 'baixa', m: string) => { if (n === 'baixa' || nivel === 'alta') nivel = n; motivos.push(m); };
  if (fila.some((a) => a.status === 'falta_dado')) rebaixa('media', 'Algumas ações sem hurdle/cockpit (Falta dado).');
  // pior sinal entre os CANDIDATOS também conta (antes era ignorado): ex. sleeve company-level sem cockpit granular.
  if (fila.some((a) => a.confianca === 'baixa')) rebaixa('media', 'Inclui ação de confiança baixa (ex.: sleeve company-level sem cockpit granular).');
  if (Object.values(input.caixaPorEmpresa).some((c) => c.confianca === 'baixa')) rebaixa('baixa', 'Projeção de caixa de alguma empresa com confiança baixa.');

  return { fila, caixa_por_empresa: input.caixaPorEmpresa, confianca: { nivel, motivos }, gerado_em: new Date().toISOString() };
}
