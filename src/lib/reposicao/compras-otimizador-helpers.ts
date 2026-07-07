// src/lib/reposicao/compras-otimizador-helpers.ts
// Otimizador de Compras — decisão "comprar mais?" net-R$ MARGINAL por SKU. Módulo puro (TDD).
// Toda a matemática vive aqui; a view v_otimizador_compras_insumos só junta os fatos.
// Metodologia: docs/superpowers/specs/2026-05-25-otimizador-compras-design.md (Codex 2 passes).

type EscopoPromo = 'sku' | 'grupo' | 'fornecedor_total';
export type RecomendacaoCompra = 'comprar_mais' | 'manter_base' | 'simulacao_parcial' | 'falta_dado';
export interface FaixaDesconto { volume_minimo: number; desconto_promo_perc: number; prazo_perc?: number }

export function qtdMinimaEfetiva(lote: number | null, forcado: number | null): number {
  return Math.max(lote ?? 0, forcado ?? 0);
}

export function qtdBase(input: { qtde_base: number | null; lote_minimo_fornecedor: number | null; minimo_forcado_manual: number | null }): number {
  // Spec §2/§8: q_base arredondado ao múltiplo do lote. A RPC entrega a qtde do ciclo via EOQ+ceil
  // SEM arredondar ao lote do fornecedor (re-Codex verificou a RPC) → arredondamos aqui. Sem lote → só ceil.
  const bruto = Math.max(input.qtde_base ?? 0, qtdMinimaEfetiva(input.lote_minimo_fornecedor, input.minimo_forcado_manual));
  return arredondaLote(bruto, input.lote_minimo_fornecedor);
}

// Piso de quantidade por "mínimo de compra forçado" por SKU (a "R" pedida pelo founder).
// Espelha EXATAMENTE o cálculo de qtde_final da RPC gerar_pedidos_sugeridos_ciclo:
//   CASE WHEN minimo_forcado_manual > 0 THEN GREATEST(qtde_natural, minimo) ELSE qtde_natural END
// Sem mínimo válido → retorna o natural INTOCADO (sem piso-0 fantasma). Mínimo inválido
// (≤0 / NaN / Infinity) NÃO força (degradação honesta — coerente com o CHECK do banco). A guarda de
// "só eleva item que JÁ precisa repor" NÃO vive aqui — é o filtro `qtde_natural > 0` da RPC;
// este helper é só o cálculo do piso da quantidade.
export function aplicarMinimoForcado(qtdeNatural: number, minimoForcado: number | null): number {
  if (minimoForcado != null && Number.isFinite(minimoForcado) && minimoForcado > 0) {
    return Math.max(qtdeNatural, minimoForcado);
  }
  return qtdeNatural;
}

// Integeriza uma quantidade de COMPRA: arredonda PRA CIMA (nunca sub-pedir) e nunca negativa.
// Motivo: o estoque do Omie vem com poeira decimal (tinta medida em litros) → a RPC faz
// estoque_maximo(inteiro) − estoque(6,00004) = 3,99996; sem ceil isso vira quantidade fracionária
// no pedido e chega ao fornecedor (Omie IncluirPedCompra). Nenhum item de pedido pode ser fracionário.
// Espelho EXATO desta regra: `ceil(...)` na RPC gerar_pedidos_sugeridos_ciclo e `Math.ceil(...)` no
// disparo (disparar-pedidos-aprovados). Entrada não-finita/≤0 → 0 (campo limpo / linha zerada).
export function quantidadeCompraInteira(n: number | null | undefined): number {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.ceil(v));
}

// Melhor desconto cujo volume_minimo ≤ q (curva progressiva → pega o maior aplicável).
export function descontoAplicavel(curva: FaixaDesconto[], q: number): number {
  let best = 0;
  for (const f of curva) { if (q >= f.volume_minimo && f.desconto_promo_perc > best) best = f.desconto_promo_perc; }
  return best;
}

// Prazo da faixa de MAIOR volume aplicável (≤ q) com prazo_perc definido — espelha descontoAplicavel
// (a faixa que você ATINGE é a de maior volume). NÃO o antigo `.find`, que pegava a 1ª faixa com prazo
// (a de menor volume) e subestimava o encargo de prazo em curvas progressivas (achado do Codex).
// null = nenhuma faixa com prazo aplicável (cai no prazo_padrao no caller).
export function prazoAplicavel(curva: FaixaDesconto[], q: number): number | null {
  // Prazo da faixa de MAIOR volume aplicável (≤ q) — o prazo é o DELA (ou null se ela não tem prazo).
  // NÃO herda o prazo de uma faixa de volume MENOR (re-Codex: faixa-aplicável-sem-prazo → cai no padrão,
  // não no prazo de uma faixa abaixo). Empate de volume → maior prazo_perc (conservador, determinístico).
  let melhorVol = -1;
  for (const f of curva) { if (q >= f.volume_minimo && f.volume_minimo > melhorVol) melhorVol = f.volume_minimo; }
  if (melhorVol < 0) return null;
  let prazo: number | null = null;
  for (const f of curva) {
    if (f.volume_minimo === melhorVol && f.prazo_perc != null && (prazo == null || f.prazo_perc > prazo)) prazo = f.prazo_perc;
  }
  return prazo;
}

function arredondaLote(q: number, lote: number | null): number {
  if (!lote || lote <= 0) return Math.ceil(q);
  return Math.ceil(q / lote) * lote;
}

// Candidatos: q_base + cada volume_minimo (≥ q_base) + limite do aumento + limite da ruptura +
// qtd de oportunidade sugerida pelo sistema, no lote.
export function gerarCandidatos(input: {
  q_base: number; lote: number | null; demanda_diaria: number | null;
  curva: FaixaDesconto[]; dias_ate_aumento: number | null; ruptura_dias: number | null;
  qtd_oportunidade?: number | null;
}): number[] {
  const set = new Set<number>([input.q_base]);
  for (const f of input.curva) { const q = arredondaLote(f.volume_minimo, input.lote); if (q >= input.q_base) set.add(q); }
  const d = input.demanda_diaria ?? 0;
  if (d > 0 && input.dias_ate_aumento != null && input.dias_ate_aumento > 0) {
    const q = arredondaLote(d * input.dias_ate_aumento, input.lote); if (q >= input.q_base) set.add(q);
  }
  if (d > 0 && input.ruptura_dias != null && input.ruptura_dias > 0) {
    const q = arredondaLote(d * input.ruptura_dias, input.lote); if (q >= input.q_base) set.add(q);
  }
  if (input.qtd_oportunidade != null && input.qtd_oportunidade > 0) {
    const q = arredondaLote(input.qtd_oportunidade, input.lote); if (q >= input.q_base) set.add(q);
  }
  return [...set].sort((a, b) => a - b);
}

export function capitalExtra(input: { valor_extra: number; cm_anual: number; demanda_diaria: number | null; q_base: number; q_extra: number }): number {
  const d = input.demanda_diaria ?? 0;
  if (d <= 0) return 0;
  const diasEfetivos = (input.q_base / d) + 0.5 * (input.q_extra / d);
  return input.valor_extra * input.cm_anual * (diasEfetivos / 365);
}

export function aumentoEvitadoRs(input: { q_cand: number; q_base: number; demanda_diaria: number | null; dias_ate_aumento: number | null; aumento_perc: number | null; preco_unit: number }): number {
  const d = input.demanda_diaria ?? 0;
  // dias_ate_aumento <= 0 (não < 0): com 0 o aumento vigora HOJE → não há janela
  // pra antecipar a compra; creditar "aumento evitado" seria ganho fictício
  // (consumoAteVigencia=0 deixaria toda a qtd extra elegível). Alinha com a geração
  // de candidato, que já exige dias_ate_aumento > 0.
  if (!input.aumento_perc || input.dias_ate_aumento == null || input.dias_ate_aumento <= 0) return 0;
  const consumoAteVigencia = d * input.dias_ate_aumento;
  const qElegivel = Math.max(0, input.q_cand - Math.max(input.q_base, consumoAteVigencia));
  return qElegivel * input.preco_unit * (input.aumento_perc / 100);
}

export function impactoPrazoRs(input: { prazo_cand_perc: number | null; prazo_padrao_perc: number | null; valor_candidato: number }): number {
  const cand = input.prazo_cand_perc ?? input.prazo_padrao_perc ?? 0;
  const padrao = input.prazo_padrao_perc ?? 0;
  return (cand - padrao) / 100 * input.valor_candidato; // + = encargo (custo); − = desconto (benefício)
}

// Frete INCREMENTAL de comprar mais. Como "comprar mais" = aumentar o MESMO pedido (não um pedido
// separado — semântica confirmada pelo founder 2026-06), só o frete % do valor escala com a qtd extra.
// Frete FIXO e TAXA DE PEDIDO são por-pedido → o pedido base já os paga → SUNK, não incrementais
// (achado do Codex; o spec §2/§8 "modela os 3" era impreciso). Eles viram flag informativa, não custo.
export function freteIncrementalRs(input: { valor_extra: number; frete_perc_valor: number | null }): number {
  return (input.frete_perc_valor ?? 0) / 100 * input.valor_extra;
}

export function descontoIncrementalRs(input: { curva: FaixaDesconto[]; q_cand: number; q_base: number; preco_unit: number }): number {
  const dCand = descontoAplicavel(input.curva, input.q_cand) / 100;
  const dBase = descontoAplicavel(input.curva, input.q_base) / 100;
  return input.q_cand * input.preco_unit * dCand - input.q_base * input.preco_unit * dBase;
}

export interface InsumoSku {
  empresa: string; sku: string; fornecedor: string;
  preco_unit: number;
  demanda_diaria: number | null;
  qtde_base: number | null;
  lote_minimo_fornecedor: number | null;
  minimo_forcado_manual: number | null;
  cm_anual: number;
  prazo_padrao_perc: number | null;
  frete_perc_valor: number | null;
  frete_fixo: number | null;
  frete_taxa_pedido: number | null;
  aumento_evitado_perc: number | null;
  dias_ate_aumento: number | null;
  ruptura_valor_estimado: number | null;
  ruptura_dias: number | null;
  curva_desconto: FaixaDesconto[];
  qtd_oportunidade?: number | null;
  escopo: EscopoPromo;
}

export interface DecisaoCompra {
  empresa: string; sku: string; fornecedor: string;
  q_base: number; q_candidata: number; q_extra: number; dias_cobertura_extra: number;
  desconto_rs: number; aumento_evitado_rs: number; ruptura_evitada_rs: number;
  capital_extra_rs: number; impacto_prazo_rs: number; frete_incremental_rs: number;
  beneficio_liquido_rs: number;
  recomendacao: RecomendacaoCompra;
  escopo: EscopoPromo;
  eoq_recalculo_ignorado: true;
  flags: string[];
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
}

const DESCONTO_ALTO = 0.20;

function scoreConfianca(input: { escopo: EscopoPromo; motivos: string[] }): { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] } {
  let nivel: 'alta' | 'media' | 'baixa' = 'alta';
  if (input.escopo !== 'sku') nivel = 'media';
  if (input.motivos.length > 0 && nivel === 'alta') nivel = 'media';
  return { nivel, motivos: input.motivos };
}

export function avaliarComprarMais(ins: InsumoSku): DecisaoCompra {
  const flags: string[] = ['Ignora validade/obsolescência/armazém/caixa-crédito/câmbio/impostos/cesta (fase 1).'];
  const motivos: string[] = [];
  const q_base = qtdBase(ins);

  // Custo de capital ausente/≤0 NÃO é "capital grátis" — é config faltando. Sem ele não dá pra netar o
  // carregamento → falta_dado (re-Codex; alinha com o A4 "nunca assume custo 0"), não recomenda às cegas.
  const semCapital = !Number.isFinite(ins.cm_anual) || ins.cm_anual <= 0;
  if ((ins.demanda_diaria ?? 0) <= 0 || (ins.qtde_base ?? 0) <= 0 || semCapital) {
    return {
      empresa: ins.empresa, sku: ins.sku, fornecedor: ins.fornecedor, q_base, q_candidata: q_base, q_extra: 0,
      dias_cobertura_extra: 0, desconto_rs: 0, aumento_evitado_rs: 0, ruptura_evitada_rs: 0, capital_extra_rs: 0,
      impacto_prazo_rs: 0, frete_incremental_rs: 0, beneficio_liquido_rs: 0, recomendacao: 'falta_dado',
      escopo: ins.escopo, eoq_recalculo_ignorado: true,
      flags: [...flags, semCapital ? 'Custo de capital ausente/≤0 — sem custo de carregamento não dá pra netar.' : 'Sem demanda/qtde de ciclo — não dá pra dimensionar.'],
      confianca: { nivel: 'baixa', motivos: [semCapital ? 'Custo de capital não configurado.' : 'Faltam demanda/qtde base.'] },
    };
  }

  if (ins.ruptura_valor_estimado != null) motivos.push('Benefício de ruptura não estimado (conservador = 0).');
  flags.push('Benefício de ruptura não estimado (conservador, fase 1).');
  // Frete fixo/taxa por-pedido são SUNK (mesmo pedido) → fora do net marginal; sinaliza pro comprador.
  if ((ins.frete_fixo ?? 0) > 0 || (ins.frete_taxa_pedido ?? 0) > 0) flags.push('Frete fixo/taxa de pedido no fornecedor — SUNK no mesmo pedido, fora da decisão marginal.');

  const candidatos = gerarCandidatos({ q_base, lote: ins.lote_minimo_fornecedor, demanda_diaria: ins.demanda_diaria,
    curva: ins.curva_desconto, dias_ate_aumento: ins.dias_ate_aumento, ruptura_dias: ins.ruptura_dias,
    qtd_oportunidade: ins.qtd_oportunidade });

  let melhor: DecisaoCompra | null = null;
  for (const q_cand of candidatos) {
    const q_extra = q_cand - q_base;
    const valor_extra = q_extra * ins.preco_unit;
    const valor_candidato = q_cand * ins.preco_unit;
    const dias_cobertura_extra = q_extra / (ins.demanda_diaria as number);
    const desconto_rs = descontoIncrementalRs({ curva: ins.curva_desconto, q_cand, q_base, preco_unit: ins.preco_unit });
    const aumento_evitado_rs = aumentoEvitadoRs({ q_cand, q_base, demanda_diaria: ins.demanda_diaria, dias_ate_aumento: ins.dias_ate_aumento, aumento_perc: ins.aumento_evitado_perc, preco_unit: ins.preco_unit });
    const ruptura_evitada_rs = 0;
    const capital_extra_rs = capitalExtra({ valor_extra, cm_anual: ins.cm_anual, demanda_diaria: ins.demanda_diaria, q_base, q_extra });
    const prazo_cand_perc = prazoAplicavel(ins.curva_desconto, q_cand) ?? ins.prazo_padrao_perc;
    const impacto_prazo_rs = impactoPrazoRs({ prazo_cand_perc, prazo_padrao_perc: ins.prazo_padrao_perc, valor_candidato });
    const frete_incremental_rs = freteIncrementalRs({ valor_extra, frete_perc_valor: ins.frete_perc_valor });
    const beneficio_liquido_rs = desconto_rs + aumento_evitado_rs + ruptura_evitada_rs - capital_extra_rs - impacto_prazo_rs - frete_incremental_rs;
    const cand: DecisaoCompra = {
      empresa: ins.empresa, sku: ins.sku, fornecedor: ins.fornecedor, q_base, q_candidata: q_cand, q_extra,
      dias_cobertura_extra, desconto_rs, aumento_evitado_rs, ruptura_evitada_rs, capital_extra_rs, impacto_prazo_rs,
      frete_incremental_rs, beneficio_liquido_rs, recomendacao: 'manter_base', escopo: ins.escopo,
      eoq_recalculo_ignorado: true, flags, confianca: { nivel: 'alta', motivos },
    };
    if (!melhor || cand.beneficio_liquido_rs > melhor.beneficio_liquido_rs) melhor = cand;
  }

  const r = melhor as DecisaoCompra;
  if (descontoAplicavel(ins.curva_desconto, r.q_candidata) > 0) {
    flags.push('Desconto assume que a qtd base não atinge o piso da promo (piso real indisponível na fase 1).');
  }
  if (descontoAplicavel(ins.curva_desconto, r.q_candidata) / 100 > DESCONTO_ALTO) {
    flags.push('Desconto alto: EOQ não recalculado com preço descontado — confiança reduzida.');
    motivos.push('Desconto >20% sem recálculo de EOQ.');
  }
  r.recomendacao = (r.q_candidata > r.q_base && r.beneficio_liquido_rs > 0)
    ? (ins.escopo === 'sku' ? 'comprar_mais' : 'simulacao_parcial')
    : 'manter_base';
  r.confianca = scoreConfianca({ escopo: ins.escopo, motivos });
  return r;
}
