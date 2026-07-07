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
  credito_reposicao: number;          // v1.1: sobra escoável valorizada ao melhor custo/base do grupo (0 sem demanda)
  custo_total_ajustado: number;
  preco_status: StatusPreco;
}

export function avaliarOpcao(
  necessidadeBase: number,
  opcao: OpcaoEmbalagem,
  params: ParamsEmbalagem,
  precoReposicaoPorBase?: number | null, // v1.1: menor custo/base do grupo (a compra futura que a sobra evita)
): AvaliacaoOpcao | null {
  if (opcao.preco == null || opcao.fator_para_base <= 0) return null;
  const fator = opcao.fator_para_base;
  const custo_por_base = opcao.preco / fator;
  const qtd_embalagens = Math.ceil(necessidadeBase / fator);
  const unidades_base_compradas = qtd_embalagens * fator;
  const excedente_base = unidades_base_compradas - necessidadeBase;
  const custo_direto = qtd_embalagens * opcao.preco;

  const d = params.demanda_base_diaria ?? 0;
  const temEscoamento = params.demanda_base_diaria != null && d > 0;
  let capital_carrego: number | null;
  if (temEscoamento) {
    const dias_escoa = excedente_base / d;
    capital_carrego = excedente_base * custo_por_base * params.custo_capital_anual * (dias_escoa / 365);
  } else {
    capital_carrego = null;
  }
  // v1.1 (spec §14): a sobra ESCOÁVEL antecipa a próxima compra — crédito ao melhor
  // custo/base do grupo, capado no custo/base da própria opção (invariante:
  // custo_total ≥ necessidade × custo_por_base, nunca negativo). Sem demanda/cm não
  // há evidência de escoamento → crédito 0 = comportamento conservador da v1.
  const credito_reposicao = temEscoamento && precoReposicaoPorBase != null && precoReposicaoPorBase > 0
    ? excedente_base * Math.min(precoReposicaoPorBase, custo_por_base)
    : 0;
  const custo_total_ajustado = custo_direto + (capital_carrego ?? 0) - credito_reposicao;

  return {
    sku_codigo_omie: opcao.sku_codigo_omie,
    custo_por_base,
    qtd_embalagens,
    unidades_base_compradas,
    excedente_base,
    custo_direto,
    capital_carrego,
    credito_reposicao,
    custo_total_ajustado,
    preco_status: opcao.preco_status ?? 'ok',
  };
}

type StatusDecisao = 'ok' | 'indisponivel' | 'marginal';

export interface DecisaoEmbalagem {
  status: StatusDecisao;
  recomendada: string | null;          // sku_codigo_omie ou null
  opcoes: AvaliacaoOpcao[];
  excedente_base: number;              // da opção recomendada
  capital_estimado: number | null;     // da opção recomendada
  dias_escoamento_sobra: number | null; // v1.1: tempo p/ a sobra da recomendada virar consumo (null sem sobra/demanda)
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
      excedente_base: 0, capital_estimado: null, dias_escoamento_sobra: null,
      economia_vs_alternativa: 0, flags: ['necessidade_invalida'],
    };
  }

  // Só preço informado + fator válido contam. < 2 → indisponível.
  const validas = opcoes.filter((o) => o.preco != null && o.fator_para_base > 0 && o.preco_status !== 'falhou');
  if (validas.length < 2) {
    return {
      status: 'indisponivel', recomendada: null, opcoes: [],
      excedente_base: 0, capital_estimado: null, dias_escoamento_sobra: null,
      economia_vs_alternativa: 0, flags: ['preco_indisponivel'],
    };
  }

  if (validas.some((o) => o.preco_status === 'stale')) flags.push('preco_desatualizado');
  const temEscoamento = params.demanda_base_diaria != null && params.demanda_base_diaria > 0;
  if (!temEscoamento) flags.push('escoamento_nao_estimado');

  // v1.1: preço de reposição = melhor custo/base do grupo (a compra que a sobra evita).
  const precoReposicaoPorBase = Math.min(...validas.map((o) => (o.preco as number) / o.fator_para_base));

  // Sem demanda registrada (decisão do founder, spec §14.2): o item gira (consumo
  // interno oculto), mas não dá pra estimar escoamento → NÃO banca crédito; ordena
  // pelo menor custo POR BASE (recomenda o galão, mais barato/litro) com aviso. Com
  // demanda, ordena pelo custo total ajustado da v1.1 (custo_direto + carrego − crédito).
  const chave = (a: AvaliacaoOpcao) => (temEscoamento ? a.custo_total_ajustado : a.custo_por_base);
  const avals = validas
    .map((o) => avaliarOpcao(necessidade_base, o, params, precoReposicaoPorBase))
    .filter((a): a is AvaliacaoOpcao => a !== null)
    .sort((a, b) => chave(a) - chave(b));

  const melhor = avals[0];

  let status: StatusDecisao = 'ok';
  let recomendada = melhor.sku_codigo_omie;

  // Guard de overbuy marginal (só com demanda — sem ela o critério é custo/base, e
  // comparar custo direto desfaria a escolha pelo galão que o founder pediu): se a
  // mais barata gera excedente e a economia vs a opção de MENOR excedente é < limiar,
  // não vale o overbuy. [codex P1] Antes usava `excedente === 0` — com necessidade
  // fracionária NENHUMA opção casa exato, o guard sumia e o galão ganhava por centavos.
  // A conservadora correta é a de menor sobra (necessidade inteira → casa exato → idêntico).
  if (temEscoamento && melhor.excedente_base > 0) {
    const conservadora = avals
      .filter((a) => a.sku_codigo_omie !== melhor.sku_codigo_omie)
      .reduce<AvaliacaoOpcao | null>((best, a) => (best == null || a.excedente_base < best.excedente_base ? a : best), null);
    if (
      conservadora &&
      conservadora.excedente_base < melhor.excedente_base &&
      conservadora.custo_total_ajustado - melhor.custo_total_ajustado < params.limiar_minimo_economia_rs
    ) {
      status = 'marginal';
      recomendada = conservadora.sku_codigo_omie;
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

  // v1.1: sobra da recomendada tratada como antecipação de compra (p/ a UI explicar).
  if (recAval.excedente_base > 0 && recAval.credito_reposicao > 0) flags.push('sobra_antecipa_compra');
  const d = params.demanda_base_diaria ?? 0;
  const dias_escoamento_sobra = recAval.excedente_base > 0 && params.demanda_base_diaria != null && d > 0
    ? recAval.excedente_base / d
    : null;

  return {
    status, recomendada, opcoes: avals,
    excedente_base: recAval.excedente_base,
    capital_estimado: recAval.capital_carrego,
    dias_escoamento_sobra,
    economia_vs_alternativa,
    flags,
  };
}
