// "Cores do cliente" em 1 toque (Fase 2A): a cor que o cliente já comprou volta ao pedido
// sem abrir o seletor — MAS só quando a fórmula é inequívoca e o MOTOR deu preço vendável.
// Qualquer dúvida (cor só por nome, 0 ou 2+ fórmulas, motor carregando/falhou, R$ 0) cai
// no diálogo, que é o caminho completo. Precisão > recall: o atalho nunca adivinha.
import { tokensDeBusca } from '@/lib/postgrest';
import { precoVendavel } from './pode-adicionar';
import { selectAltPrice, type AltPriceSource, type TintPriceBreakdownLite } from './select-price';

/** Normaliza código de cor para o casamento EXATO (o histórico grava "346j" ou "346J"). */
export function normalizarCodigoCor(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** O CÓDIGO dentro do `cor_id` do catálogo: a 1ª palavra. Medido em 2026-10-12: 7.168 das
 *  8.692 cores Oben têm `cor_id` "CÓDIGO - BS" ("H109 - BS"), 714 só o código, 783 o código
 *  + linha ("012S - ACRIL BS"). 195 códigos repetem entre linhas — a unicidade é por BASE. */
export function codigoDoCorId(corId: string): string {
  return normalizarCodigoCor(corId).split(' ')[0] ?? '';
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

// Palavras do rótulo do histórico que NÃO identificam cor (embalagem, sufixo de base).
const PALAVRAS_SEM_COR = new Set(['bs', 'ml', 'gl', 'qt', 'lt', 'litro', 'litros', 'galao', 'lata', 'para', 'com', 'de', 'da', 'do']);
const palavrasDeCor = (s: string) =>
  tokensDeBusca(s).filter((w) => w.length >= 3 && !/\d/.test(w) && !PALAVRAS_SEM_COR.has(w));

/** Codex P1 (rodada 2): o código extraído do rótulo livre ("346J - ACRIL BS" → "346J") pode
 *  casar com OUTRA cor de mesmo código. Do texto, só aceita quando o nome do catálogo divide
 *  ≥1 palavra de cor com o rótulo comprado ("PLATINA BIANCA 900ML" × "PLATINA BIANCO"). */
export function nomeCompativel(rotuloHistorico: string, nomeCatalogo: string): boolean {
  const doRotulo = new Set(palavrasDeCor(rotuloHistorico));
  return palavrasDeCor(nomeCatalogo).some((w) => doRotulo.has(w));
}

/** A fórmula do 1 toque: a ÚNICA da base (sku) cujo `cor_id` é exatamente o código.
 *  `rotuloHistorico` null = o código É a identidade (item do app, `tint_cor_id`); senão o
 *  nome do catálogo precisa ser compatível com o rótulo. 0 ou 2+ ⇒ null (abre o diálogo). */
export function escolherFormulaUmToque(
  skuId: string,
  codigo: string,
  candidatas: CandidataUmToque[],
  rotuloHistorico: string | null,
): CandidataUmToque | null {
  const alvo = normalizarCodigoCor(codigo);
  if (!alvo) return null;
  // Identidade exata (tint_cor_id do item do app) compara o cor_id INTEIRO; código extraído
  // do rótulo compara com o código do cor_id ("H109" × "H109 - BS").
  if (rotuloHistorico != null && !ehCodigoDeCor(codigo)) return null;
  const casam = candidatas.filter(
    (c) =>
      c.sku_id === skuId &&
      (rotuloHistorico == null ? normalizarCodigoCor(c.cor_id) === alvo : codigoDoCorId(c.cor_id) === alvo),
  );
  if (casam.length !== 1) return null;
  if (rotuloHistorico != null && !nomeCompativel(rotuloHistorico, casam[0].nome_cor)) return null;
  return casam[0];
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
