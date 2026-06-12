import { extrairCodigosSayerlack, sufixoSayerlack } from '@/lib/reposicao/sayerlack-sku';

/**
 * Normaliza o CÓDIGO de um boletim para a identidade canônica:
 * NFKC + upper + trim + remove espaços internos. Mantém pontos e sufixo de
 * embalagem (GL/QT/LT/.00) — são identidade, não ruído (decisão Codex 2026-06-11).
 * Espelhada no SQL (trigger product_code_normalized) — manter as duas em sincronia.
 */
export function normalizeProductCode(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, '').trim();
}

export interface SkuCandidato {
  account: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
}

export interface CandidatoRefinado extends SkuCandidato {
  match: 'exato' | 'fraco';      // 'exato' = a BASE do boletim ∈ bases dos códigos da descrição
  ambiguo: boolean;              // descrição tem >1 BASE distinta → exige escolha humana
  codigosNaDescricao: string[];
}

/** Base da fórmula = código sem o sufixo de EMBALAGEM (QT/GL/LT/FG/L5...). O sufixo é a
 *  embalagem (1 fórmula → N embalagens); o número (.NNNN.NN) identifica a fórmula e é
 *  preservado. FO20.6827.00GL → FO20.6827.00 ; FO20.6827.00 → FO20.6827.00. */
export function baseDoCodigo(codigo: string | null | undefined): string {
  const norm = normalizeProductCode(codigo);
  const suf = sufixoSayerlack(norm); // ([A-Z]{1,3}\d?)$ — só as letras finais
  return suf ? norm.slice(0, norm.length - suf.length) : norm;
}

/** Termos LIKE pro pré-filtro SQL: o código, a BASE (pega todas as embalagens) e o miolo
 *  numérico (3-4 díg) estável, que casa a descrição mesmo quando o separador difere. */
export function montarTermosBusca(codigo: string | null | undefined): string[] {
  const norm = normalizeProductCode(codigo);
  if (!norm) return [];
  const termos = new Set<string>([norm]);
  const base = baseDoCodigo(norm);
  if (base) termos.add(base); // base pega todas as embalagens quando o boletim vem com sufixo
  const miolo = norm.match(/\d{3,4}/)?.[0];
  if (miolo) termos.add(miolo);
  return [...termos];
}

/** Refina candidatos brutos do pré-filtro por BASE da fórmula (reusa o extrator Sayerlack,
 *  que exige o sufixo de embalagem colado e normaliza espaço→ponto) + marca ambiguidade.
 *  Decisão Codex: só 'exato' E não-ambíguo é auto-confirmável; o resto é triagem humana. */
export function refinarCandidatos(
  codigoBoletim: string | null | undefined,
  candidatos: SkuCandidato[],
): CandidatoRefinado[] {
  const alvoBase = baseDoCodigo(codigoBoletim);
  return candidatos.map((c) => {
    const codigos = extrairCodigosSayerlack(c.descricao).map(normalizeProductCode);
    const bases = [...new Set(codigos.map(baseDoCodigo))];
    return {
      ...c,
      codigosNaDescricao: codigos,
      match: alvoBase !== '' && bases.includes(alvoBase) ? 'exato' : 'fraco',
      ambiguo: bases.length > 1,
    };
  });
}
