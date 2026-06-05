/**
 * Helpers PUROS de apresentação para a UI da Caça (Frente B).
 *
 * Sem IO, sem imports externos além dos tipos locais.
 * Cada função é determinística e totalmente testável.
 */

import type { SaborCaca } from './types';

/**
 * Rótulo em pt-BR do sabor de caça para exibir ao vendedor.
 */
export function labelSabor(s: SaborCaca): string {
  switch (s) {
    case 'cross_empresa':
      return 'Compra em outra empresa do grupo';
    case 'dormente':
      return 'Parou de comprar';
    case 'frio':
      return 'Nunca comprou';
  }
}

/**
 * Faixa qualitativa de confiança baseada no valor numérico (0–1).
 *
 * >= 0.75 → alta
 * >= 0.40 → media
 * < 0.40  → baixa
 */
export function faixaConfianca(c: number): 'alta' | 'media' | 'baixa' {
  if (c >= 0.75) return 'alta';
  if (c >= 0.40) return 'media';
  return 'baixa';
}

/**
 * Classe de cor do design system para o badge de sabor.
 * Usa os tokens text-status-* do projeto (sem classes Tailwind hardcoded).
 */
export function classeSabor(s: SaborCaca): string {
  switch (s) {
    case 'cross_empresa':
      return 'text-status-info';
    case 'dormente':
      return 'text-status-warning';
    case 'frio':
      return 'text-muted-foreground';
  }
}

/**
 * Monta um href `tel:` para o telefone fornecido.
 *
 * Retorna `null` se o telefone for null, vazio ou contiver apenas espaços.
 * Mantém apenas os dígitos no href para compatibilidade máxima com apps nativos.
 */
export function telLink(tel: string | null): string | null {
  if (tel === null) return null;
  const digitos = tel.replace(/\D/g, '');
  if (digitos.length === 0) return null;
  return `tel:${digitos}`;
}

// ─── Agrupamento por documento ────────────────────────────────────────────────

import type { CacaCandidatoDisplay } from './types';

/**
 * Representa um candidato agrupado: um documento pode aparecer em múltiplas
 * empresas-alvo; exibimos um único card com a lista de empresas.
 */
export interface CandidatoAgrupado {
  /** CNPJ/CPF normalizado (chave de agrupamento). */
  documento: string;
  /** Todas as empresas-alvo para este documento (pode ser 1 ou mais). */
  empresasAlvo: string[];
  /** Dados de apresentação do candidato (usamos o de maior rankFinal, ou seja, menor número). */
  display: CacaCandidatoDisplay;
}

/**
 * Agrupa candidatos pelo documento, juntando empresas-alvo diferentes num único card.
 *
 * Para cada grupo, usa o candidato com melhor `rankFinal` (menor número) como
 * representante para dados de apresentação (nome, telefone, sabor, confiança etc.).
 *
 * A ordem final preserva o ranking do representante de cada grupo.
 */
export function agruparPorDocumento(
  candidatos: CacaCandidatoDisplay[],
): CandidatoAgrupado[] {
  // Map: documento → { representante, set de empresas }
  const grupos = new Map<string, { melhor: CacaCandidatoDisplay; empresas: Set<string> }>();

  for (const c of candidatos) {
    const doc = c.features.documento;
    const existing = grupos.get(doc);
    if (!existing) {
      grupos.set(doc, { melhor: c, empresas: new Set([c.features.empresaAlvo]) });
    } else {
      existing.empresas.add(c.features.empresaAlvo);
      // Mantém o candidato com melhor rank (menor rankFinal) como representante
      if (c.rankFinal < existing.melhor.rankFinal) {
        existing.melhor = c;
      }
    }
  }

  // Converte para array e ordena pelo rankFinal do representante
  return Array.from(grupos.values())
    .sort((a, b) => a.melhor.rankFinal - b.melhor.rankFinal)
    .map(({ melhor, empresas }) => ({
      documento: melhor.features.documento,
      empresasAlvo: Array.from(empresas).sort(),
      display: melhor,
    }));
}
