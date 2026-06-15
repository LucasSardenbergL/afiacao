// Oráculo puro do cockpit de preço (Fase 2a). A RPC get_preco_cockpit (SQL numeric)
// é a AUTORIDADE em runtime — a UI lê a faixa da RPC, não deste helper. Este helper
// documenta a lógica e é o oráculo do teste; por ser float (JS), pode divergir da RPC
// (numeric exato) em fronteiras decimais — NÃO usar pra decisão em runtime.

export type Faixa = 'vermelho' | 'amarelo' | 'verde' | 'neutro';
export type Motivo =
  | 'abaixo_do_custo' | 'abaixo_do_piso' | 'abaixo_da_meta'
  | 'saudavel' | 'sem_custo' | 'sem_politica';

export interface FaixaInput {
  preco: number;
  cmc: number | null;
  pisoMarkup: number | null;  // %
  metaMarkup: number | null;  // %
  temCusto: boolean;
  temPolitica: boolean;
}

export function classificarFaixa(i: FaixaInput): { faixa: Faixa; motivo: Motivo } {
  // #7: preço/cmc inválido (null/NaN/Infinity) → neutro, NUNCA verde fabricado.
  if (!Number.isFinite(i.preco)) {
    return { faixa: 'neutro', motivo: 'sem_custo' };
  }
  if (!i.temCusto || i.cmc == null || !Number.isFinite(i.cmc) || !(i.cmc > 0)) {
    return { faixa: 'neutro', motivo: 'sem_custo' };
  }
  if (i.preco < i.cmc) {
    return { faixa: 'vermelho', motivo: 'abaixo_do_custo' };
  }
  if (!i.temPolitica || i.pisoMarkup == null || i.metaMarkup == null) {
    return { faixa: 'neutro', motivo: 'sem_politica' };
  }
  const piso = i.cmc * (1 + i.pisoMarkup / 100);
  const meta = i.cmc * (1 + i.metaMarkup / 100);
  if (i.preco < piso) return { faixa: 'amarelo', motivo: 'abaixo_do_piso' };
  if (i.preco < meta) return { faixa: 'verde', motivo: 'abaixo_da_meta' };
  return { faixa: 'verde', motivo: 'saudavel' };
}

/** Markup bruto sobre CMC (%) e folga (R$). null se cmc inválido. */
export function markupSobreCmc(preco: number, cmc: number | null): { markupPerc: number; folgaReais: number } | null {
  if (cmc == null || !(cmc > 0)) return null;
  return { markupPerc: ((preco - cmc) / cmc) * 100, folgaReais: preco - cmc };
}
