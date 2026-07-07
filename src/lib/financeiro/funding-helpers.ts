// Custo Marginal de Funding — helper puro. Espelhado VERBATIM na edge function Deno
// supabase/functions/fin-funding/index.ts. Toda a metodologia: spec 2026-05-25-financeiro-funding-divida.
// Princípio: tudo em R$ no horizonte; taxa anualizada só pra exibir. Pré-imposto (sem tax-shield).

export type TipoFonte = 'caixa_proprio' | 'antecipacao' | 'capital_giro' | 'cheque_especial';

// IOF de operação de crédito PJ: 0,38% fixo + 0,0082%/dia (parcela diária limitada a 365 dias).
export function iofCredito(valor: number, dias: number): number {
  if (valor <= 0) return 0;
  const diasCap = Math.min(Math.max(dias, 0), 365);
  return valor * (0.000082 * diasCap + 0.0038);
}

// Custo em R$ de prover M reais por D dias a uma taxa anual efetiva (fração).
export function custoEmReais(M: number, dias: number, taxaAnual: number): number {
  if (M <= 0 || dias <= 0 || taxaAnual <= 0) return 0;
  return M * (Math.pow(1 + taxaAnual, dias / 365) - 1);
}

export type AntecipacaoResult = {
  desagio: number; iof: number; tarifa: number; v_liq: number;
  custo_rs: number; taxa_efetiva_aa: number | null;
};

// Antecipação/desconto de um título (face V, vence em N dias). Deságio comercial "por fora".
export function custoAntecipacao(input: {
  valor: number; dias: number; taxa_desconto_mensal: number; // fração a.m.
  tipo: 'desconto' | 'factoring'; tarifa_fixa?: number;
}): AntecipacaoResult {
  const { valor, dias } = input;
  const desagio = valor * input.taxa_desconto_mensal * (dias / 30);
  const iof = input.tipo === 'desconto' ? iofCredito(valor, dias) : 0;
  const tarifa = input.tarifa_fixa ?? 0;
  const v_liq = valor - desagio - iof - tarifa;
  const custo_rs = valor - v_liq;
  const taxa_efetiva_aa = v_liq > 0 && dias > 0 ? Math.pow(valor / v_liq, 365 / dias) - 1 : null;
  return { desagio, iof, tarifa, v_liq, custo_rs, taxa_efetiva_aa };
}

// Custo de oportunidade do caixa próprio (fração a.a.), sensível à alocação A4.
export function custoOportunidadeCaixa(input: {
  cm_anual: number;
  retorno_marginal_a4: number | null;
  ha_fila_a4_positiva: boolean;
  caixa_suficiente: boolean;
}): number {
  if (input.ha_fila_a4_positiva && !input.caixa_suficiente && input.retorno_marginal_a4 != null) {
    return Math.max(input.cm_anual, input.retorno_marginal_a4);
  }
  return input.cm_anual;
}

export type Semana = {
  inicio: string; fim: string; saldo_final: number; total_saidas: number;
  entradas: { id_origem: string; data: string; valor: number }[];
};

export type Contexto = 'gap' | 'sobra' | 'indefinido';

export function classificarContexto(input: {
  tem_projecao: boolean; menor_saldo_ate_n: number | null; reserva_rs: number;
}): Contexto {
  if (!input.tem_projecao || input.menor_saldo_ate_n == null) return 'indefinido';
  return input.menor_saldo_ate_n < input.reserva_rs ? 'gap' : 'sobra';
}

// Simulação de 2 cenários: antecipar adiciona v_liq hoje e remove o recebimento (id_origem) na semana k.
// Delta sobre saldo_final: +v_liq em todas; -valorEntrada de k em diante. Vale criado se algum saldo
// de k em diante cai < reserva no alternativo mas estava >= reserva no base.
export function checaValeEmT(input: {
  semanas: Semana[]; titulo_id: string; v_liq: number; reserva_rs: number;
}): boolean {
  const { semanas, titulo_id, v_liq, reserva_rs } = input;
  const k = semanas.findIndex((s) => s.entradas.some((e) => e.id_origem === titulo_id));
  if (k < 0) return false;
  const valorEntrada = semanas[k].entradas
    .filter((e) => e.id_origem === titulo_id)
    .reduce((acc, e) => acc + e.valor, 0);
  for (let i = k; i < semanas.length; i++) {
    const base = semanas[i].saldo_final;
    const alt = base + v_liq - valorEntrada;
    if (alt < reserva_rs && base >= reserva_rs) return true;
  }
  return false;
}

export function classificarEstrutural(input: {
  semanas: Semana[]; reserva_rs: number; limiar_semanas: number;
}): boolean {
  const comGap = input.semanas.filter((s) => s.saldo_final < input.reserva_rs).length;
  return comGap >= input.limiar_semanas;
}

type FonteBenchmark = TipoFonte | 'melhor_uso_a4';
type Recomendacao = 'antecipar' | 'nao_antecipar' | 'falta_dado';

export type DecisaoTitulo = {
  titulo: { id: string; valor: number; dias: number; nome_cliente: string | null };
  v_liq: number;
  custo_rs_antecipacao: number;
  taxa_efetiva_aa: number | null;
  contexto: Contexto;
  benchmark_fonte: FonteBenchmark | null;
  custo_rs_benchmark: number | null;
  net_rs: number | null;
  recomendacao: Recomendacao;
  flags: string[];
};

export function decidirTitulo(input: {
  titulo: { id: string; valor: number; dias: number; nome_cliente?: string | null };
  antecipacao: { taxa_desconto_mensal: number | null; tipo: 'desconto' | 'factoring'; tarifa_fixa?: number; coobrigacao: boolean };
  alternativas: { capital_giro_cet?: number | null; cheque_cet?: number | null };
  cm_anual: number | null;
  retorno_marginal_a4: number | null;
  contexto: Contexto;
  flags_extra: string[];
}): DecisaoTitulo {
  const t = { id: input.titulo.id, valor: input.titulo.valor, dias: input.titulo.dias, nome_cliente: input.titulo.nome_cliente ?? null };
  const flags = [...input.flags_extra];
  if (input.antecipacao.coobrigacao) flags.push('coobrigacao');

  // Sem taxa de antecipação configurada/ativa → não há como avaliar a antecipação. Degrada honesto
  // (NUNCA fabrica "antecipar com custo zero" passando taxa 0).
  if (input.antecipacao.taxa_desconto_mensal == null) {
    return {
      titulo: t, v_liq: 0, custo_rs_antecipacao: 0, taxa_efetiva_aa: null,
      contexto: input.contexto, benchmark_fonte: null, custo_rs_benchmark: null, net_rs: null,
      recomendacao: 'falta_dado', flags: [...flags, 'sem_taxa_antecipacao'],
    };
  }
  const ant = custoAntecipacao({ valor: t.valor, dias: t.dias, taxa_desconto_mensal: input.antecipacao.taxa_desconto_mensal, tipo: input.antecipacao.tipo, tarifa_fixa: input.antecipacao.tarifa_fixa });

  const base: DecisaoTitulo = {
    titulo: t, v_liq: ant.v_liq, custo_rs_antecipacao: ant.custo_rs, taxa_efetiva_aa: ant.taxa_efetiva_aa,
    contexto: input.contexto, benchmark_fonte: null, custo_rs_benchmark: null, net_rs: null, recomendacao: 'falta_dado', flags,
  };
  if (ant.v_liq <= 0) return base;

  if (input.contexto === 'gap') {
    const cands: { fonte: FonteBenchmark; custo: number }[] = [];
    if (input.alternativas.capital_giro_cet != null) cands.push({ fonte: 'capital_giro', custo: custoEmReais(ant.v_liq, t.dias, input.alternativas.capital_giro_cet) });
    if (input.alternativas.cheque_cet != null) cands.push({ fonte: 'cheque_especial', custo: custoEmReais(ant.v_liq, t.dias, input.alternativas.cheque_cet) });
    if (cands.length === 0) return base;
    const melhor = cands.reduce((a, b) => (b.custo < a.custo ? b : a));
    const net = melhor.custo - ant.custo_rs;
    return { ...base, benchmark_fonte: melhor.fonte, custo_rs_benchmark: melhor.custo, net_rs: net, recomendacao: net > 0 ? 'antecipar' : 'nao_antecipar' };
  }

  // sobra | indefinido: o caixa liberado renderia rBench; antecipar vale se ganho > custo.
  if (input.contexto === 'indefinido') flags.push('sem_projecao');
  const benchmarks: number[] = [];
  if (input.cm_anual != null) benchmarks.push(input.cm_anual);
  if (input.retorno_marginal_a4 != null) benchmarks.push(input.retorno_marginal_a4);
  if (benchmarks.length === 0) {
    // Sem custo de oportunidade do caixa (cm_anual) nem retorno de uso (A4) → não há benchmark pra
    // avaliar a sobra. Degrada honesto (NUNCA fabrica recomendação com benchmark zero).
    return { ...base, recomendacao: 'falta_dado', flags: [...flags, 'sem_custo_capital'] };
  }
  const rBench = Math.max(...benchmarks);
  const ganho = custoEmReais(ant.v_liq, t.dias, rBench);
  const net = ganho - ant.custo_rs;
  const benchmark_fonte: FonteBenchmark = input.retorno_marginal_a4 != null ? 'melhor_uso_a4' : 'caixa_proprio';
  return { ...base, benchmark_fonte, custo_rs_benchmark: ganho, net_rs: net, recomendacao: net > 0 ? 'antecipar' : 'nao_antecipar' };
}

export function identificarGap(input: {
  semanas: Semana[]; reserva_rs: number;
}): { gap_rs: number; semana_idx: number; horizonte_dias: number } | null {
  if (input.semanas.length === 0) return null;
  let piorIdx = -1; let piorSaldo = Infinity; let ultimoAbaixo = -1;
  input.semanas.forEach((s, i) => {
    if (s.saldo_final < piorSaldo) { piorSaldo = s.saldo_final; piorIdx = i; }
    if (s.saldo_final < input.reserva_rs) ultimoAbaixo = i; // última semana ABAIXO da reserva
  });
  if (ultimoAbaixo < 0) return null; // nunca fura a reserva → sem gap
  // gap_rs = pico da necessidade (vale mais profundo). horizonte = até a RECUPERAÇÃO (última semana
  // abaixo da reserva), NÃO a semana do vale — senão um déficit plano/estrutural daria 7 dias e
  // subestimaria brutalmente o custo (a cobertura fica imobilizada até o caixa voltar acima da reserva).
  return { gap_rs: input.reserva_rs - piorSaldo, semana_idx: piorIdx, horizonte_dias: (ultimoAbaixo + 1) * 7 };
}

export type FonteCobertura = {
  fonte: TipoFonte; rate_aa: number; capacidade_rs: number; governanca_ordem: number;
};
type ItemStack = { fonte: TipoFonte; montante_rs: number; custo_rs: number; flag?: string };
export type PlanoCobertura = {
  gap_rs: number; horizonte_dias: number; stack: ItemStack[];
  custo_total_rs: number; custo_inercia_rs: number | null; motivos: string[];
};

export function montarPlanoCobertura(input: {
  gap_rs: number; horizonte_dias: number; fontes: FonteCobertura[]; cheque_rate_aa: number | null;
}): PlanoCobertura {
  const { gap_rs, horizonte_dias } = input;
  const motivos: string[] = [];
  // Ordena por CUSTO EM R$ de prover 1 real pelo horizonte (não por % a.a.); desempate por governança.
  const ordenadas = [...input.fontes].sort((a, b) => {
    const ca = custoEmReais(1, horizonte_dias, a.rate_aa);
    const cb = custoEmReais(1, horizonte_dias, b.rate_aa);
    if (ca !== cb) return ca - cb;
    return a.governanca_ordem - b.governanca_ordem;
  });
  const stack: ItemStack[] = [];
  let restante = gap_rs;
  for (const f of ordenadas) {
    if (restante <= 0) break;
    const usa = Math.min(restante, f.capacidade_rs);
    if (usa <= 0) continue;
    const item: ItemStack = { fonte: f.fonte, montante_rs: usa, custo_rs: custoEmReais(usa, horizonte_dias, f.rate_aa) };
    if (f.fonte === 'cheque_especial' && f.governanca_ordem >= 3) item.flag = 'emergencia';
    stack.push(item);
    restante -= usa;
  }
  if (restante > 0.01) motivos.push(`Capacidade das fontes insuficiente — R$ ${restante.toFixed(2)} descoberto.`);
  const custo_total_rs = stack.reduce((s, x) => s + x.custo_rs, 0);
  // Sem taxa de cheque → custo da inércia é DESCONHECIDO (null), NUNCA 0 (0 faria "cobrir agora"
  // parecer pior que não fazer nada). Degrada honesto.
  const custo_inercia_rs = input.cheque_rate_aa != null ? custoEmReais(gap_rs, horizonte_dias, input.cheque_rate_aa) : null;
  return { gap_rs, horizonte_dias, stack, custo_total_rs, custo_inercia_rs, motivos };
}
