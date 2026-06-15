// Seleção honesta da fonte de preço de uma cor tintométrica no balcão (Passo 2).
//
// O motor `get_tint_price` já devolve o preço CALCULADO honesto (base + corantes,
// NULL quando a base é ausente/zero ou algum corante não tem custo). Esta função
// decide QUAL preço usar na venda, durante a transição em que o CSV legado
// (`preco_final_sayersystem`) ainda coexiste com o cálculo.
//
// Descoberta que motiva a regra (diagnóstico de prod, 15/06): o CSV de ~54k cores
// foi congelado SEM a base (cobra só os corantes) — subfaturamento. O cálculo
// inclui a base e corrige. Mas em ~19k cores o cálculo dá MENOR que o CSV (preço
// Omie mais novo, ou dado a revisar): nessas, manter o CSV (não baixar por engano).
//
// Regras (money-path — precisão > recall, nunca fabricar, nunca baixar silencioso):
//  1. Base ausente/zero num produto vendável → SEM PREÇO, mesmo havendo CSV/cliente
//     (o CSV também subfatura aqui; ex.: PRD03657). Corrigir no Omie.
//  2. Preço do cliente (último praticado) vence — é acordo comercial explícito.
//  3. Calc e CSV ambos: usa o MAIOR. calc > CSV (Grupo B) → recalcula e avisa o
//     balcão ("a base não estava no importado"); calc ≈ CSV → usa o calc sem aviso;
//     calc < CSV → mantém o CSV (não baixa na transição).
//  4. Só calc → usa o calc. Só CSV (calc NULL por corante, base OK) → fallback CSV.
//  5. Nada confiável → SEM PREÇO (a UI desabilita "Adicionar"; nunca R$ 0).

import type { TintPriceBreakdown } from './compute-price';

export type TintPriceSource = 'cliente' | 'tabela' | 'calculado';
/** Por que não há preço — alimenta a mensagem honesta na UI. */
export type SemPrecoMotivo = 'base' | 'corante' | 'receita';

export interface TintPriceSelection {
  /** Fonte escolhida; NULL = sem preço (não vender com número fabricado). */
  source: TintPriceSource | null;
  /** Preço antes de desconto; NULL = sem preço. */
  precoSemDesconto: number | null;
  /** O cálculo recalculou ACIMA do importado (base não estava no CSV) → avisar. */
  recalculado: boolean;
  /** Preço importado anterior, para o aviso "antes R$X". Só quando recalculado. */
  precoImportadoAnterior: number | null;
  /** Quando source é NULL, o porquê (para a mensagem da UI). */
  motivoSemPreco: SemPrecoMotivo | null;
}

/** Arredonda pra cima ao R$0,10 — paridade com o tratamento histórico do CSV. */
const arredonda = (v: number) => Math.ceil(v * 10) / 10;

/** Tolerância de "batem" entre calc e CSV (arredondamento/centavos). */
const TOLERANCIA = 0.1;

const semPreco = (motivo: SemPrecoMotivo): TintPriceSelection => ({
  source: null,
  precoSemDesconto: null,
  recalculado: false,
  precoImportadoAnterior: null,
  motivoSemPreco: motivo,
});

const comPreco = (
  source: TintPriceSource,
  precoSemDesconto: number,
  recalculado = false,
  precoImportadoAnterior: number | null = null,
): TintPriceSelection => ({ source, precoSemDesconto, recalculado, precoImportadoAnterior, motivoSemPreco: null });

export function selectTintPrice(input: {
  lastPracticedPrice: number | null;
  /** CSV bruto (>0) ou null/0; arredondado internamente. */
  precoCsv: number | null;
  /** Breakdown do motor honesto; null enquanto carrega. */
  pricing: TintPriceBreakdown | null;
}): TintPriceSelection {
  const { lastPracticedPrice, pricing } = input;
  const csv = input.precoCsv != null && input.precoCsv > 0 ? arredonda(input.precoCsv) : null;
  const calc = pricing?.precoFinal != null ? arredonda(pricing.precoFinal) : null;

  // 1. Base ausente/zero (pricing carregado e baseDisponivel=false): sem preço SEMPRE.
  //    Não confiar no CSV nem perpetuar preço de cliente — o dado precisa de correção no Omie.
  if (pricing && !pricing.baseDisponivel) return semPreco('base');

  // 2. Preço do cliente (negociado) vence.
  if (lastPracticedPrice != null && lastPracticedPrice > 0) return comPreco('cliente', lastPracticedPrice);

  // 3. Calc e CSV coexistem.
  if (calc != null && csv != null) {
    if (calc > csv + TOLERANCIA) return comPreco('calculado', calc, true, csv); // Grupo B: sobe → avisa
    if (calc >= csv - TOLERANCIA) return comPreco('calculado', calc);            // batem: usa o calc, sem aviso
    return comPreco('tabela', csv);                                              // calc < CSV: mantém (não baixa)
  }

  // 4. Só uma das fontes.
  if (calc != null) return comPreco('calculado', calc);
  if (csv != null) return comPreco('tabela', csv);

  // 5. Sem nada confiável → sem preço, com o motivo (para a mensagem).
  if (pricing && !pricing.corantesCompletos) return semPreco('corante');
  return semPreco('receita');
}
