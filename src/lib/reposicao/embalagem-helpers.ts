// src/lib/reposicao/embalagem-helpers.ts
// Decisão de embalagem econômica (QT/GL) — módulo puro (TDD).
// Spec: docs/superpowers/specs/2026-06-04-embalagem-economica-design.md
// Capital de carrego espelha compras-otimizador-helpers.ts (capitalExtra).

export type StatusPreco = 'ok' | 'stale' | 'falhou';

export interface OpcaoEmbalagem {
  sku_codigo_omie: string;
  fator_para_base: number;            // QT=1, GL=4
  preco: number | null;               // null = preço não informado
  preco_status: StatusPreco | null;
  lote_minimo?: number | null;        // v1: não usado na decisão (Fase 3)
}

export interface ParamsEmbalagem {
  custo_capital_anual: number;        // decimal, ex.: 0.30
  limiar_minimo_economia_rs: number;  // piso p/ valer o overbuy
  demanda_base_diaria?: number | null;// p/ estimar escoamento do excedente
}

export interface AvaliacaoOpcao {
  sku_codigo_omie: string;
  custo_por_base: number;             // preco / fator
  qtd_embalagens: number;
  unidades_base_compradas: number;
  excedente_base: number;
  custo_direto: number;
  capital_carrego: number | null;     // null quando demanda ausente
  custo_total_ajustado: number;
  preco_status: StatusPreco;
}

export function avaliarOpcao(
  necessidadeBase: number,
  opcao: OpcaoEmbalagem,
  params: ParamsEmbalagem,
): AvaliacaoOpcao | null {
  if (opcao.preco == null || opcao.fator_para_base <= 0) return null;
  const fator = opcao.fator_para_base;
  const custo_por_base = opcao.preco / fator;
  const qtd_embalagens = Math.ceil(necessidadeBase / fator);
  const unidades_base_compradas = qtd_embalagens * fator;
  const excedente_base = unidades_base_compradas - necessidadeBase;
  const custo_direto = qtd_embalagens * opcao.preco;

  const d = params.demanda_base_diaria ?? 0;
  let capital_carrego: number | null;
  if (params.demanda_base_diaria != null && d > 0) {
    const dias_escoa = excedente_base / d;
    capital_carrego = excedente_base * custo_por_base * params.custo_capital_anual * (dias_escoa / 365);
  } else {
    capital_carrego = null;
  }
  const custo_total_ajustado = custo_direto + (capital_carrego ?? 0);

  return {
    sku_codigo_omie: opcao.sku_codigo_omie,
    custo_por_base,
    qtd_embalagens,
    unidades_base_compradas,
    excedente_base,
    custo_direto,
    capital_carrego,
    custo_total_ajustado,
    preco_status: opcao.preco_status ?? 'ok',
  };
}

export type StatusDecisao = 'ok' | 'indisponivel' | 'marginal';

export interface DecisaoEmbalagem {
  status: StatusDecisao;
  recomendada: string | null;          // sku_codigo_omie ou null
  opcoes: AvaliacaoOpcao[];
  excedente_base: number;              // da opção recomendada
  capital_estimado: number | null;     // da opção recomendada
  economia_vs_alternativa: number;     // R$ entre a mais barata e a 2ª (>= 0)
  flags: string[];
}

export function escolherEmbalagemEconomica(input: {
  necessidade_base: number;
  opcoes: OpcaoEmbalagem[];
  params: ParamsEmbalagem;
}): DecisaoEmbalagem {
  const { necessidade_base, opcoes, params } = input;
  const flags: string[] = [];

  // necessidade_base inválida (0/negativa/não-finita) → sem decisão. [codex P2]
  if (!(necessidade_base > 0) || !Number.isFinite(necessidade_base)) {
    return {
      status: 'indisponivel', recomendada: null, opcoes: [],
      excedente_base: 0, capital_estimado: null, economia_vs_alternativa: 0,
      flags: ['necessidade_invalida'],
    };
  }

  // Só preço informado + fator válido contam. < 2 → indisponível.
  const validas = opcoes.filter((o) => o.preco != null && o.fator_para_base > 0 && o.preco_status !== 'falhou');
  if (validas.length < 2) {
    return {
      status: 'indisponivel', recomendada: null, opcoes: [],
      excedente_base: 0, capital_estimado: null, economia_vs_alternativa: 0,
      flags: ['preco_indisponivel'],
    };
  }

  if (validas.some((o) => o.preco_status === 'stale')) flags.push('preco_desatualizado');
  if (params.demanda_base_diaria == null || params.demanda_base_diaria <= 0) flags.push('escoamento_nao_estimado');

  const avals = validas
    .map((o) => avaliarOpcao(necessidade_base, o, params))
    .filter((a): a is AvaliacaoOpcao => a !== null)
    .sort((a, b) => a.custo_total_ajustado - b.custo_total_ajustado);

  const melhor = avals[0];

  let status: StatusDecisao = 'ok';
  let recomendada = melhor.sku_codigo_omie;

  // Guard de overbuy marginal: se a mais barata gera excedente e a economia
  // vs a melhor opção SEM excedente é < limiar, não vale o overbuy.
  if (melhor.excedente_base > 0) {
    const semExc = avals.find((a) => a.excedente_base === 0);
    if (semExc && (semExc.custo_total_ajustado - melhor.custo_total_ajustado) < params.limiar_minimo_economia_rs) {
      status = 'marginal';
      recomendada = semExc.sku_codigo_omie;
      flags.push('overbuy_marginal');
    } else {
      flags.push('overbuy_compensa');
    }
  }

  const recAval = avals.find((a) => a.sku_codigo_omie === recomendada) as AvaliacaoOpcao;
  // Economia da RECOMENDADA vs a melhor alternativa (clamp 0). No caso marginal a
  // recomendada é a conservadora (mais cara) → economia 0, não a do overbuy descartado.
  const outras = avals.filter((a) => a.sku_codigo_omie !== recomendada);
  const economia_vs_alternativa = outras.length
    ? Math.max(0, Math.min(...outras.map((a) => a.custo_total_ajustado)) - recAval.custo_total_ajustado)
    : 0;

  return {
    status, recomendada, opcoes: avals,
    excedente_base: recAval.excedente_base,
    capital_estimado: recAval.capital_carrego,
    economia_vs_alternativa,
    flags,
  };
}
