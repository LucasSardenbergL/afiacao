// Preço do SIMULADOR admin (TintPricing) = o preço que o BALCÃO cobraria.
//
// Fase 4 da remediação tintométrica (docs/superpowers/plans/2026-07-17-tint-
// receita-perdida-remediacao.md): a tela tinha um motor de preço PARALELO
// (base×imposto×margem + corantes crus) que fabricava número com receita
// vazia/parcial e divergia por construção do que o balcão cobra. Este helper
// NÃO calcula nada: delega a seleção a `selectTintPrice` — a mesma regra de
// `selectAltPrice` (alternativas/busca global do balcão) — e só acrescenta o
// MOTIVO textual do "sem preço", que a tela de decisão de quem precifica
// precisa ver e as alternativas do balcão omitem. Paridade provada por teste
// contra selectAltPrice; divergir daqui = motor paralelo de volta.

import { selectTintPrice, type TintPriceBreakdownLite } from './select-price';

export interface SimuladorPrecoView {
  /** carregando = batch ainda sem resposta (nunca mostrar CSV nesse meio-tempo). */
  status: 'carregando' | 'com-preco' | 'sem-preco';
  /** O preço que o balcão cobraria (já arredondado a R$0,10); null fora de com-preco. */
  preco: number | null;
  fonte: 'calculado' | 'tabela' | null;
  /** O cálculo recalculou ACIMA do CSV importado (Grupo B) — mostrar "antes R$X". */
  recalculado: boolean;
  precoImportadoAnterior: number | null;
  /** Candidatos do seletor da vendedora (arredondados); null quando sem-preco —
   *  o balcão bloqueia TODAS as fontes sem preço confiável, e aqui também. */
  precoCalc: number | null;
  precoTabela: number | null;
  /** Mensagem honesta quando sem-preco — diz a AÇÃO, nunca um número fabricado. */
  motivo: string | null;
}

/** Paridade com o arredondamento do balcão (select-price `arredonda` / hook `Math.ceil(x*10)/10`);
 *  o teste amarra `preco === precoCalc` no caso recalculado — drift aqui quebra o assert. */
const arredonda = (v: number) => Math.ceil(v * 10) / 10;

const MOTIVO_SIMULADOR = {
  base: 'Base sem preço ou inativa no Omie — o balcão não vende; corrigir o produto no Omie.',
  corante: 'Corante sem custo ou inativo no Omie — o balcão não vende; vincular o corante.',
  receitaVazia: 'Fórmula sem receita (0 corantes) — o balcão não vende esta cor.',
  receita: 'Receita incompleta — o balcão não vende esta cor.',
  indisponivel: 'Motor de preço não respondeu para esta fórmula — sem preço honesto.',
} as const;

export function precoSimulador(input: {
  /** `preco_csv_legado` da view canônica (CSV da chave, Fase 2b). */
  precoCsv: number | null;
  /** Breakdown do motor batch (get_tint_prices); null = sem entrada no mapa. */
  pricing: TintPriceBreakdownLite | null;
  /** O batch ainda está carregando — segurar o preço (não cair no CSV). */
  batchCarregando: boolean;
  /** `tem_receita` da view canônica — refina a mensagem (receita perdida ≠ corante sem custo). */
  temReceita: boolean | null;
}): SimuladorPrecoView {
  const { precoCsv, pricing, batchCarregando, temReceita } = input;

  if (batchCarregando) {
    return {
      status: 'carregando', preco: null, fonte: null, recalculado: false,
      precoImportadoAnterior: null, precoCalc: null, precoTabela: null, motivo: null,
    };
  }

  // Mesmo contrato de selectAltPrice: sem breakdown após o batch responder
  // (erro da RPC ou id fora do mapa) ⇒ motor falhou ⇒ fail-closed, ignora CSV.
  const sel = selectTintPrice({ lastPracticedPrice: null, precoCsv, pricing, motorFalhou: pricing == null });

  if (sel.precoSemDesconto == null) {
    const motivo =
      sel.motivoSemPreco === 'base' ? MOTIVO_SIMULADOR.base
      : sel.motivoSemPreco === 'corante' ? (temReceita === false ? MOTIVO_SIMULADOR.receitaVazia : MOTIVO_SIMULADOR.corante)
      : sel.motivoSemPreco === 'receita' ? MOTIVO_SIMULADOR.receita
      : MOTIVO_SIMULADOR.indisponivel;
    return {
      status: 'sem-preco', preco: null, fonte: null, recalculado: false,
      precoImportadoAnterior: null, precoCalc: null, precoTabela: null, motivo,
    };
  }

  return {
    status: 'com-preco',
    preco: sel.precoSemDesconto,
    fonte: sel.source === 'cliente' ? null : sel.source, // simulador não tem preço de cliente
    recalculado: sel.recalculado,
    precoImportadoAnterior: sel.recalculado ? sel.precoImportadoAnterior : null,
    precoCalc: pricing?.precoFinal != null ? arredonda(pricing.precoFinal) : null,
    precoTabela: precoCsv != null && precoCsv > 0 ? arredonda(precoCsv) : null,
    motivo: null,
  };
}
