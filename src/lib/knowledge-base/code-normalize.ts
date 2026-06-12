// Helper de casamento boletim técnico ↔ item de venda (busca reversa).
//
// Problema: o código do boletim (ex.: "FO20.6827.00") vive no CAMPO `product_code`
// do `kb_product_specs`, mas na tabela `omie_products` esse mesmo código está
// EMBUTIDO na DESCRIÇÃO ("VERNIZ PU FO20.6827.00 GL"), nunca no `codigo` (que é um
// identificador interno do Omie). O casamento precisa extrair e comparar por token.
//
// Regra money-path (precisão > recall): ambiguidade → não auto-confirmar.
// Decisão Codex 2026-06-11: só `match='exato'` E `ambiguo=false` é auto-confirmável;
// o resto exige triagem humana.

import { extrairCodigosSayerlack } from '@/lib/reposicao/sayerlack-sku';

/**
 * Normaliza o CÓDIGO de um boletim para a identidade canônica:
 * NFKC + upper + trim + remove espaços internos. Mantém pontos e sufixo de
 * embalagem (GL/QT/LT/.00) — são identidade, não ruído (decisão Codex 2026-06-11).
 * Espelhada no SQL (trigger product_code_normalized) — manter as duas em sincronia.
 */
export function normalizeProductCode(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, '').trim();
}

/**
 * Monta os termos de pré-filtro SQL (ILIKE) a partir do código do boletim:
 * 1. O código inteiro normalizado (busca exata possível)
 * 2. O miolo numérico (3-4 dígitos) — estável entre variantes de separador;
 *    casa a descrição mesmo quando o separador difere (ponto ↔ espaço).
 * Pré-filtro: alta recall; `refinarCandidatos` faz o refinamento preciso depois.
 */
export function montarTermosBusca(codigo: string | null | undefined): string[] {
  const norm = normalizeProductCode(codigo);
  if (!norm) return [];
  const termos = new Set<string>([norm]);
  // Primeiro grupo de 3-4 dígitos consecutivos (ex.: "6827" de "FO20.6827.00")
  const miolo = norm.match(/\d{3,4}/)?.[0];
  if (miolo) termos.add(miolo);
  return [...termos];
}

/** Forma mínima de um produto Omie para o casamento. */
export interface SkuCandidato {
  account: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
}

/** Resultado do refinamento por candidato. */
export interface CandidatoRefinado extends SkuCandidato {
  /** 'exato' = código do boletim ∈ tokens extraídos da descrição pelo parser Sayerlack. */
  match: 'exato' | 'fraco';
  /** true quando a descrição tem >1 código distinto → exige escolha humana (não auto-confirmar). */
  ambiguo: boolean;
  /** Códigos Sayerlack distintos encontrados na descrição (após normalização). */
  codigosNaDescricao: string[];
}

/**
 * Refina candidatos brutos vindos do pré-filtro SQL:
 * - Usa `extrairCodigosSayerlack` para obter os códigos da descrição (já normaliza
 *   espaço→ponto para tingidores).
 * - `match='exato'` quando o código do boletim está entre os tokens extraídos.
 * - `ambiguo=true` quando há >1 código distinto na descrição (não auto-confirmável).
 *
 * Decisão de design: normalizar os códigos extraídos com `normalizeProductCode`
 * antes de comparar, para que "FO20.6827.00" == "fo20.6827.00" etc.
 */
export function refinarCandidatos(
  codigoBoletim: string | null | undefined,
  candidatos: SkuCandidato[],
): CandidatoRefinado[] {
  const alvo = normalizeProductCode(codigoBoletim);
  return candidatos.map((c) => {
    // extrairCodigosSayerlack já normaliza espaço→ponto (tingidores), então
    // normalizeProductCode sobre a saída só faz upper/trim/remove-espaços.
    const codigos = extrairCodigosSayerlack(c.descricao).map(normalizeProductCode);
    const distintos = [...new Set(codigos)];
    return {
      ...c,
      codigosNaDescricao: distintos,
      match: distintos.includes(alvo) ? 'exato' : 'fraco',
      ambiguo: distintos.length > 1,
    };
  });
}
