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
//  0. Motor (RPC) FALHOU/não respondeu e NÃO está mais carregando → SEM PREÇO (fail-closed):
//     não cair no CSV/cliente quando a fronteira honesta não confirmou (a RPC pode estar barrando
//     base/corante inativo ou zerado). Diferente de "carregando" (aí o consumidor segura a venda).
//  1. Base ausente/zero num produto vendável → SEM PREÇO, mesmo havendo CSV/cliente
//     (o CSV também subfatura aqui; ex.: PRD03657). Corrigir no Omie.
//  2. Preço do cliente (último praticado) vence — é acordo comercial explícito.
//  3. Calc e CSV ambos: usa o MAIOR. calc > CSV (Grupo B) → recalcula e avisa o
//     balcão ("a base não estava no importado"); calc ≈ CSV → usa o calc sem aviso;
//     calc < CSV → mantém o CSV (não baixa na transição).
//  4. Só calc → usa o calc. Só CSV (calc NULL por corante, base OK) → fallback CSV.
//  5. Nada confiável → SEM PREÇO (a UI desabilita "Adicionar"; nunca R$ 0).

import type { TintPriceBreakdown } from './compute-price';

/** O agregado de preço SEM a receita (itensCorantes) — o que a RPC batch devolve e o
 *  que a seleção realmente usa. O breakdown completo (single) é atribuível a este.
 *  custoCorantes é number|null: a RPC esconde o custo (NULL) para não-staff — gate de
 *  segurança P1 (migration 20260708234100). O customer só usa precoFinal, não o custo. */
export type TintPriceBreakdownLite = Omit<TintPriceBreakdown, 'itensCorantes' | 'custoCorantes'> & {
  custoCorantes: number | null;
};

export type TintPriceSource = 'cliente' | 'tabela' | 'calculado';
/** Por que não há preço — alimenta a mensagem honesta na UI. */
export type SemPrecoMotivo = 'base' | 'corante' | 'receita' | 'indisponivel';

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
  pricing: TintPriceBreakdownLite | null;
  /** A RPC do motor já respondeu mas FALHOU (erro/permissão/runtime) ou não trouxe breakdown, e
   *  NÃO está mais carregando. Fail-closed: aqui NÃO cair no CSV legado / preço-cliente — a RPC é a
   *  fronteira honesta (pode estar barrando base/corante inativo); número velho subfatura ou vende
   *  produto desativado. ≠ `pricing == null` por loading (nesse caso o consumidor segura a venda). */
  motorFalhou?: boolean;
}): TintPriceSelection {
  const { lastPracticedPrice, pricing } = input;

  // 0. Motor falhou (≠ carregando) → SEM PREÇO, mesmo havendo CSV/cliente. A RPC não confirmou o
  //    preço honesto; cair no importado aqui venderia justamente o que a RPC poderia estar barrando.
  if (input.motorFalhou) return semPreco('indisponivel');

  const csv = input.precoCsv != null && input.precoCsv > 0 ? arredonda(input.precoCsv) : null;
  const calc = pricing?.precoFinal != null ? arredonda(pricing.precoFinal) : null;

  // 1. Motor honesto JÁ respondeu e SEM preço confiável (precoFinal null = base ausente/zero OU
  //    corante sem custo) → SEM PREÇO, mesmo havendo CSV ou preço de cliente. Não confiar no
  //    importado nem perpetuar preço antigo: o dado precisa de correção no Omie (self-healing).
  if (pricing && pricing.precoFinal == null) {
    if (!pricing.baseDisponivel) return semPreco('base');
    if (!pricing.corantesCompletos) return semPreco('corante');
    return semPreco('receita');
  }

  // 2. Preço do cliente (negociado) vence.
  if (lastPracticedPrice != null && lastPracticedPrice > 0) return comPreco('cliente', lastPracticedPrice);

  // 3. Calc e CSV coexistem → o MAIOR; avisa quando o calc sobe (Grupo B).
  if (calc != null && csv != null) {
    if (calc > csv + TOLERANCIA) return comPreco('calculado', calc, true, csv); // Grupo B: sobe → avisa
    if (calc >= csv - TOLERANCIA) return comPreco('calculado', calc);            // batem: usa o calc, sem aviso
    return comPreco('tabela', csv);                                              // calc < CSV: mantém (não baixa)
  }

  // 4. Só uma fonte (pricing null aqui = ainda carregando; o consumidor segura a venda no loading).
  if (calc != null) return comPreco('calculado', calc);
  if (csv != null) return comPreco('tabela', csv);

  return semPreco('receita');
}

/** Fonte que a vendedora pode escolher numa alternativa — sem 'cliente' (não há
 *  último preço do cliente por alternativa). */
export type AltPriceSource = Extract<TintPriceSource, 'calculado' | 'tabela'>;

/** Preço de exibição de uma EMBALAGEM ALTERNATIVA (outras embalagens / busca global).
 *  Não há "último preço do cliente" por alternativa — só calc honesto vs CSV. Devolve o
 *  custoCorantes DA PRÓPRIA fórmula (não o da cor selecionada), e null quando sem preço. */
export interface AltPriceDisplay {
  /** Preço a cobrar; null = sem preço (a UI desabilita o item, nunca vende a R$ 0). */
  preco: number | null;
  fonte: AltPriceSource | null;
  /** O cálculo recalculou acima do importado (base não estava no CSV). */
  recalculado: boolean;
  custoCorantes: number;
  /** Preços por fonte quando o motor confirmou preço confiável — a UI oferece a
   *  escolha (Fase 2b-fix) só quando AMBOS existem. Sem preço confiável → ambos
   *  null: não oferecer escolha do que não pode ser vendido. */
  precoCalc: number | null;
  precoTabela: number | null;
}

const ALT_SEM_PRECO = (custoCorantes: number): AltPriceDisplay =>
  ({ preco: null, fonte: null, recalculado: false, custoCorantes, precoCalc: null, precoTabela: null });

export function selectAltPrice(
  precoCsv: number | null,
  pricing: TintPriceBreakdownLite | null,
  /** Escolha manual da vendedora (Fase 2b-fix). Só vale se a fonte escolhida tiver
   *  valor (senão segue o default = regra do maior) e NUNCA fura o fail-closed. */
  override?: AltPriceSource | null,
): AltPriceDisplay {
  // Fail-closed: sem o breakdown do motor (batch ainda carregando, erro, ou RPC não aplicada),
  // NÃO cair no CSV legado — a alternativa fica "sem preço" até o cálculo honesto chegar.
  if (!pricing) return ALT_SEM_PRECO(0);
  const sel = selectTintPrice({ lastPracticedPrice: null, precoCsv, pricing });
  // gate esconde o custo p/ não-staff (null) → 0: telemetria efêmera do carrinho, não usada p/ preço.
  const custoCorantes = pricing.custoCorantes ?? 0;

  // Sem preço confiável (base/corante/receita) → nenhuma fonte é oferecida; o override não fura.
  if (sel.precoSemDesconto == null) return ALT_SEM_PRECO(custoCorantes);

  const precoCalc = pricing.precoFinal != null ? arredonda(pricing.precoFinal) : null;
  const precoTabela = precoCsv != null && precoCsv > 0 ? arredonda(precoCsv) : null;
  const porFonte: Record<AltPriceSource, number | null> = { calculado: precoCalc, tabela: precoTabela };

  const fonteDefault: AltPriceSource | null =
    sel.source === 'calculado' || sel.source === 'tabela' ? sel.source : null;
  const fonte = override != null && porFonte[override] != null ? override : fonteDefault;
  return {
    preco: fonte ? porFonte[fonte] : null,
    fonte,
    // Aviso de recálculo só quando a fonte EXIBIDA é o cálculo que subiu (espelha o card principal).
    recalculado: fonte === 'calculado' && sel.recalculado,
    custoCorantes,
    precoCalc,
    precoTabela,
  };
}
