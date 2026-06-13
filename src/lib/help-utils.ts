/**
 * Utilities for the contextual help system.
 * Parses markdown headings to build TOC and extracts sections by anchor.
 */

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

/**
 * Convert a heading text to a slug/anchor compatible with rehype-slug.
 * Simplified GitHub-style slugger.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .trim()
    .replace(/[^\w\s-]/g, '') // remove non-word chars
    .replace(/\s+/g, '-') // spaces -> dashes
    .replace(/-+/g, '-');
}

/**
 * Extract H2/H3 headings from markdown to build a TOC.
 */
export function extractToc(markdown: string): TocItem[] {
  const lines = markdown.split('\n');
  const toc: TocItem[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      toc.push({ id: slugify(text), text, level });
    }
  }
  return toc;
}

/**
 * Extract a section of markdown between a given heading anchor and
 * the next heading of equal or higher level.
 */
export function extractSection(markdown: string, anchor: string): string {
  const targetSlug = anchor.replace(/^#/, '').toLowerCase();
  const lines = markdown.split('\n');
  const result: string[] = [];
  let capturing = false;
  let capturedLevel = 0;
  let inCodeBlock = false;

  for (const line of lines) {
    const codeFence = line.trim().startsWith('```');
    if (codeFence) inCodeBlock = !inCodeBlock;

    const headingMatch = !inCodeBlock && line.match(/^(#{1,6})\s+(.+?)\s*$/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const slug = slugify(text);

      if (capturing && level <= capturedLevel) {
        // reached next sibling/parent heading -> stop
        break;
      }

      if (!capturing && slug === targetSlug) {
        capturing = true;
        capturedLevel = level;
        result.push(line);
        continue;
      }
    }

    if (capturing) result.push(line);
  }

  return result.join('\n').trim();
}

/**
 * Map of admin routes to documentation module + anchors.
 * Each entry returns the module slug and the anchor (without leading '#').
 */
export interface HelpRouteMapping {
  module: string;
  anchor: string;
}

interface HelpRouteRule extends HelpRouteMapping {
  prefix: string;
}

/**
 * Regras de ajuda por prefixo de rota — ESPECÍFICAS antes das genéricas (a ordem
 * É a prioridade, igual à cascata de `if` que isto substituiu). Rota sem match =
 * sem ajuda contextual → `getHelpMappingForRoute` devolve `null` e o HelpDrawer
 * esconde o botão "?" em vez de abrir um painel "nada encontrado".
 *
 * ⚠️ Antes havia um fallback genérico (`eventos-comerciais/visão-geral`) que
 * casava QUALQUER rota → toda tela sem ajuda própria (ex.: /meu-dia) abria a
 * ajuda de Reposição e mostrava "nenhuma seção encontrada". O fallback foi
 * removido de propósito.
 */
const HELP_ROUTE_RULES: HelpRouteRule[] = [
  { prefix: '/admin/des/trimestre-atual', module: 'avaliacao-trimestral-des', anchor: 'posicao-ao-vivo' },
  { prefix: '/admin/des/configuracao', module: 'avaliacao-trimestral-des', anchor: 'visao-geral-do-programa-des' },
  { prefix: '/admin/des', module: 'avaliacao-trimestral-des', anchor: 'visao-geral-do-programa-des' },
  { prefix: '/admin/reposicao/negociacao-paralela', module: 'negociacao-paralela', anchor: 'ranking-de-candidatos' },
  { prefix: '/admin/reposicao/promocoes', module: 'eventos-comerciais', anchor: 'promoções' },
  { prefix: '/admin/reposicao/aumentos', module: 'eventos-comerciais', anchor: 'aumentos-anunciados' },
  { prefix: '/admin/reposicao/oportunidades', module: 'eventos-comerciais', anchor: 'oportunidades-unificadas' },
  { prefix: '/admin/reposicao/pedidos', module: 'eventos-comerciais', anchor: 'ciclo-de-oportunidade' },
  { prefix: '/admin/reposicao', module: 'eventos-comerciais', anchor: 'visão-geral' },
];

export function getHelpMappingForRoute(pathname: string): HelpRouteMapping | null {
  const rule = HELP_ROUTE_RULES.find((r) => pathname.startsWith(r.prefix));
  return rule ? { module: rule.module, anchor: rule.anchor } : null;
}

/** True só quando a rota tem ajuda contextual REAL (não o antigo fallback genérico). */
export function hasHelpForRoute(pathname: string): boolean {
  return getHelpMappingForRoute(pathname) !== null;
}

/**
 * Available help modules (one per file under src/content/help/).
 */
export interface HelpModule {
  slug: string;
  title: string;
  content: string;
}

