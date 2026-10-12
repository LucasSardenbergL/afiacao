// "Cores do cliente" em 1 toque (Fase 2A): a cor que o cliente já comprou volta ao pedido
// sem abrir o seletor — MAS só quando a fórmula é inequívoca e o MOTOR deu preço vendável.
// Qualquer dúvida (cor só por nome, 0 ou 2+ fórmulas, motor carregando/falhou, R$ 0) cai
// no diálogo, que é o caminho completo. Precisão > recall: o atalho nunca adivinha.
import { precoVendavel } from './pode-adicionar';
import { selectAltPrice, type AltPriceSource, type TintPriceBreakdownLite } from './select-price';

/** Normaliza código de cor para o casamento EXATO (o histórico grava "346j" ou "346J"). */
export function normalizarCodigoCor(s: string): string {
  return s.trim().toUpperCase();
}

/** O termo extraído do histórico só serve ao 1 toque quando é CÓDIGO (tem dígito):
 *  "PLATINA" casaria por acaso com a única cor da base que tem a palavra. */
export function ehCodigoDeCor(termo: string): boolean {
  return /\d/.test(termo) && /^[A-Z0-9.]+$/i.test(termo.trim());
}

export interface CandidataUmToque {
  id: string;
  sku_id: string;
  cor_id: string;
  nome_cor: string;
  preco_csv_legado: number | null;
}

/** A fórmula do 1 toque: a ÚNICA da base (sku) cujo `cor_id` é exatamente o código.
 *  0 ou 2+ ⇒ null (o caller abre o diálogo). */
export function escolherFormulaUmToque(
  skuId: string,
  codigo: string,
  candidatas: CandidataUmToque[],
): CandidataUmToque | null {
  if (!ehCodigoDeCor(codigo)) return null;
  const alvo = normalizarCodigoCor(codigo);
  const casam = candidatas.filter((c) => c.sku_id === skuId && normalizarCodigoCor(c.cor_id) === alvo);
  return casam.length === 1 ? casam[0] : null;
}

export interface DecisaoUmToque {
  preco: number;
  fonte: AltPriceSource;
  custoCorantes: number;
}

/** Preço do 1 toque = o MESMO das outras embalagens (`selectAltPrice`, regra do maior,
 *  sem override, sem desconto) e a MESMA condição de vender (`precoVendavel`). Sem o
 *  breakdown do motor (carregando/erro) ⇒ null — nunca o CSV sozinho. */
export function decidirUmToque(
  precoCsvLegado: number | null,
  pricing: TintPriceBreakdownLite | null | undefined,
): DecisaoUmToque | null {
  // Mesmo arredondamento ao R$0,10 que as alternativas aplicam ao CSV antes do selectAltPrice.
  const csv = precoCsvLegado ? Math.ceil(precoCsvLegado * 10) / 10 : precoCsvLegado;
  const sel = selectAltPrice(csv, pricing ?? null, null);
  if (!precoVendavel(sel.preco) || sel.fonte == null) return null;
  return { preco: sel.preco, fonte: sel.fonte, custoCorantes: sel.custoCorantes };
}
