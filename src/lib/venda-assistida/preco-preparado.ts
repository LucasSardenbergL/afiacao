/**
 * Pricing determinístico do "litro preparado" (catalisado) — Fatia 1 da venda assistida por IA.
 *
 * Money-path NÃO-NEGOCIÁVEL: a IA NUNCA define preço. B (base) e C (catalisador) saem do Omie
 * (preço da MAIOR embalagem disponível) ÷ litros do de-para abaixo. Componente obrigatório ausente
 * → "sob consulta" (status incomplete), NUNCA somado como zero (risco P0 do Codex).
 *
 * Design: docs/superpowers/specs/2026-06-14-venda-assistida-ia-design.md (§3 risco P0.2, §5).
 * Revisado por Codex adversarial (2026-06-14): P0 proporção-ausente, P1 empate/maior-sem-preço/regex-base.
 *
 * ⚠️ ESTE preço é a estimativa de ENCOMENDA pela MAIOR embalagem ("R$/litro preparado teórico").
 * NÃO é o preço de um item EM ESTOQUE (esse é o preço-do-cliente do item em estoque) — o resolver
 * (Fatia 2) NÃO deve casar este preço com estado SELLABLE_NOW (risco P0.2: preço e estoque de
 * embalagens diferentes). Também não é "preço do kit/lote" (o catalisador vem em embalagem fechada).
 *
 * De-para de litros por embalagem — CONFIRMADO PELO FOUNDER (2026-06-14):
 *   GL 3,6 (base 3,24) · QT 0,9 (base 0,81) · BH 20 (base 18) · LT 18 · L5 5 · BB 5 · BD 18 · 405ML 0,405.
 *   "base" = a descrição contém a palavra "base" (bases só existem em QT/GL/BH, com os litros menores).
 *   CGL não existe → null (sob consulta). Sufixo fora da tabela → null (nunca chute).
 *
 * % do catalisador é sobre o VOLUME DA BASE (r = pct/100): pra 1 L de base entram r L de catalisador,
 * lote final = 1+r litros → R$/litro preparado = (B + r·C)/(1+r).
 */

/** "base" como PALAVRA. O \b do JS conta `_` como letra (deixaria "BASE_GL" passar como não-base) e o
 *  \b ASCII casa após acento ("ábase"). Aqui: separador = qualquer não-letra (incl. `_`, dígito, pontuação). */
const RE_PALAVRA_BASE = /(?:^|[^a-zà-ÿ])base(?:[^a-zà-ÿ]|$)/i;

/** Litros da embalagem pelo sufixo Sayerlack + descrição. null = desconhecido → "sob consulta". */
export function litrosDaEmbalagem(sufixo: string, descricao: string): number | null {
  const desc = (descricao ?? '').toLowerCase();
  // Fracionado: o item-pai no Omie é QT, mas a descrição diz "405ML" e é o que se vende → manda a descrição.
  if (/\b405\s*ml\b/.test(desc)) return 0.405;
  const isBase = RE_PALAVRA_BASE.test(desc);
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
      litrosCatalisadorUsada: number | null;
    }
  | { status: 'incomplete'; motivo: string };

export interface PrecoPreparadoInput {
  /** Embalagens da base (escolhe a MAIOR com preço+litros conhecidos). */
  baseEmbalagens: EmbalagemPreco[];
  /** O boletim TEM catalisador (catalisador_codigo presente)? Se sim, proporção VÁLIDA é obrigatória. */
  temCatalisador: boolean;
  /** Embalagens do catalisador (maior com preço+litros); null = catalisador não mapeado. */
  catalisadorEmbalagens: EmbalagemPreco[] | null;
  /** catalisador_proporcao_pct do boletim. Só usado quando temCatalisador=true. */
  proporcaoPct: number | null;
}

function valido(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Preço/litro da MAIOR embalagem (por litros). Codex P1:
 *  - se a maior-por-litros NÃO tem preço válido → null (sob consulta), NÃO substitui por uma menor;
 *  - empate de litros → menor `valor` vence (determinístico, não depende da ordem do array).
 */
function precoLitroMaiorEmbalagem(
  embalagens: EmbalagemPreco[],
): { precoLitro: number; litros: number } | null {
  // 1) maior litragem entre as embalagens com litros válidos.
  let maxLitros = -Infinity;
  for (const e of embalagens) {
    if (valido(e.litros) && e.litros > maxLitros) maxLitros = e.litros;
  }
  if (!Number.isFinite(maxLitros)) return null; // nenhuma com litros válidos

  // 2) entre as DA maior litragem, a de menor valor válido. Nenhuma precificada → sob consulta.
  let melhorValor = Infinity;
  for (const e of embalagens) {
    if (valido(e.litros) && e.litros === maxLitros && valido(e.valor) && e.valor < melhorValor) {
      melhorValor = e.valor;
    }
  }
  if (!Number.isFinite(melhorValor)) return null; // a maior embalagem não tem preço → sob consulta

  return { precoLitro: melhorValor / maxLitros, litros: maxLitros };
}

/**
 * R$/litro preparado (catalisado), determinístico. Degrada honesto a "incomplete" ("sob consulta")
 * quando falta preço/litro de base, quando a proporção do catalisador obrigatório é desconhecida,
 * ou quando o catalisador obrigatório não tem SKU/preço/litros. Nunca zero-fill (Codex P0).
 */
export function precoLitroPreparado(input: PrecoPreparadoInput): PrecoPreparado {
  const base = precoLitroMaiorEmbalagem(input.baseEmbalagens ?? []);
  if (!base) return { status: 'incomplete', motivo: 'base sem embalagem (maior) com preço/litros conhecidos' };
  const B = base.precoLitro;

  // Produto 1-componente (boletim SEM catalisador): o "preparado" é a própria base.
  if (!input.temCatalisador) {
    if (!valido(B)) return { status: 'incomplete', motivo: 'preço-base inválido' };
    return {
      status: 'ok',
      valorLitroPreparado: round4(B),
      precoLitroBase: round4(B),
      precoLitroCatalisador: null,
      litrosBaseUsada: base.litros,
      litrosCatalisadorUsada: null,
    };
  }

  // Catalisador OBRIGATÓRIO: proporção VÁLIDA é necessária. null/NaN/Infinity/<=0 → "sob consulta"
  // (NÃO vira preço só-da-base — risco P0 do Codex: boletim incompleto virava SELLABLE_NOW barato).
  const pct = input.proporcaoPct;
  if (pct == null || !Number.isFinite(pct) || pct <= 0) {
    return { status: 'incomplete', motivo: 'catalisador obrigatório com proporção desconhecida/inválida' };
  }
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
    litrosCatalisadorUsada: cat.litros,
  };
}
