/**
 * Pricing determinístico do "litro preparado" (catalisado) — Fatia 1 da venda assistida por IA.
 *
 * Money-path NÃO-NEGOCIÁVEL: a IA NUNCA define preço. B (base) e C (catalisador) saem do Omie
 * (preço da MAIOR embalagem disponível) ÷ litros do de-para abaixo. Componente obrigatório ausente
 * → "sob consulta" (status incomplete), NUNCA somado como zero (risco P0 do Codex).
 *
 * Design: docs/superpowers/specs/2026-06-14-venda-assistida-ia-design.md (§3 risco P0.2, §5).
 *
 * De-para de litros por embalagem — CONFIRMADO PELO FOUNDER (2026-06-14):
 *   GL 3,6 (base 3,24) · QT 0,9 (base 0,81) · BH 20 (base 18) · LT 18 · L5 5 · BB 5 · BD 18 · 405ML 0,405.
 *   "base" = a descrição contém a palavra "base" (bases só existem em QT/GL/BH, com os litros menores).
 *   CGL não existe → null (sob consulta). Sufixo fora da tabela → null (nunca chute).
 *
 * % do catalisador é sobre o VOLUME DA BASE (r = pct/100): pra 1 L de base entram r L de catalisador,
 * lote final = 1+r litros → R$/litro preparado = (B + r·C)/(1+r).
 */

/** Litros da embalagem pelo sufixo Sayerlack + descrição. null = desconhecido → "sob consulta". */
export function litrosDaEmbalagem(sufixo: string, descricao: string): number | null {
  const desc = (descricao ?? '').toLowerCase();
  // Fracionado: o item-pai no Omie é QT, mas a descrição diz "405ML" e é o que se vende → manda a descrição.
  if (/\b405\s*ml\b/.test(desc)) return 0.405;
  const isBase = /\bbase\b/.test(desc);
  switch ((sufixo ?? '').toUpperCase()) {
    case 'GL': return isBase ? 3.24 : 3.6;
    case 'QT': return isBase ? 0.81 : 0.9;
    case 'BH': return isBase ? 18 : 20;
    case 'LT': return 18;
    case 'L5': return 5;
    case 'BB': return 5;
    case 'BD': return 18;
    default: return null; // CGL (não existe) e qualquer sufixo desconhecido → sob consulta
  }
}

export interface EmbalagemPreco {
  /** Preço da embalagem (R$), do Omie (valor_unitario da embalagem, NÃO por litro). */
  valor: number;
  /** Litros da embalagem (de litrosDaEmbalagem); null = não sabe → não precificável. */
  litros: number | null;
}

export type PrecoPreparado =
  | {
      status: 'ok';
      valorLitroPreparado: number;
      precoLitroBase: number;
      precoLitroCatalisador: number | null;
      litrosBaseUsada: number;
    }
  | { status: 'incomplete'; motivo: string };

export interface PrecoPreparadoInput {
  /** Embalagens da base (escolhe a MAIOR com litros conhecidos). */
  baseEmbalagens: EmbalagemPreco[];
  /** Embalagens do catalisador (maior com litros conhecidos); null = catalisador não mapeado. */
  catalisadorEmbalagens: EmbalagemPreco[] | null;
  /** catalisador_proporcao_pct do boletim. null/0 = produto 1-componente (sem catalisador). */
  proporcaoPct: number | null;
}

function valido(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Maior embalagem com litros conhecidos → {preço/litro, litros}. null se nenhuma válida. */
function precoLitroMaiorEmbalagem(
  embalagens: EmbalagemPreco[],
): { precoLitro: number; litros: number } | null {
  let melhor: { precoLitro: number; litros: number } | null = null;
  for (const e of embalagens) {
    if (!valido(e.valor) || !valido(e.litros)) continue;
    if (!melhor || e.litros > melhor.litros) {
      melhor = { precoLitro: e.valor / e.litros, litros: e.litros };
    }
  }
  return melhor;
}

/**
 * R$/litro preparado (catalisado), determinístico. Degrada honesto a "incomplete" ("sob consulta")
 * quando falta litro de base ou o catalisador obrigatório não tem SKU/preço/litros. Nunca zero-fill.
 */
export function precoLitroPreparado(input: PrecoPreparadoInput): PrecoPreparado {
  const base = precoLitroMaiorEmbalagem(input.baseEmbalagens ?? []);
  if (!base) return { status: 'incomplete', motivo: 'base sem embalagem com litros conhecidos' };
  const B = base.precoLitro;

  const pct = input.proporcaoPct;
  // Sem catalisador (produto 1-componente): o "preparado" é a própria base.
  if (pct == null || !Number.isFinite(pct) || pct <= 0) {
    return {
      status: 'ok',
      valorLitroPreparado: round4(B),
      precoLitroBase: round4(B),
      precoLitroCatalisador: null,
      litrosBaseUsada: base.litros,
    };
  }

  // Catalisador OBRIGATÓRIO (r > 0): precisa de preço/litro. Ausente → incomplete (nunca zero).
  const r = pct / 100;
  const cat = precoLitroMaiorEmbalagem(input.catalisadorEmbalagens ?? []);
  if (!cat) return { status: 'incomplete', motivo: 'catalisador obrigatório sem SKU/preço/litros' };
  const C = cat.precoLitro;

  const valorLitro = (B + r * C) / (1 + r);
  if (!valido(valorLitro)) return { status: 'incomplete', motivo: 'cálculo inválido' };

  return {
    status: 'ok',
    valorLitroPreparado: round4(valorLitro),
    precoLitroBase: round4(B),
    precoLitroCatalisador: round4(C),
    litrosBaseUsada: base.litros,
  };
}
