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

export function getHelpMappingForRoute(pathname: string): HelpRouteMapping {
  // Avaliação Trimestral DES module
  if (pathname.startsWith('/admin/des/trimestre-atual')) {
    return { module: 'avaliacao-trimestral-des', anchor: 'posicao-ao-vivo' };
  }
  if (pathname.startsWith('/admin/des/configuracao')) {
    return { module: 'avaliacao-trimestral-des', anchor: 'visao-geral-do-programa-des' };
  }
  if (pathname.startsWith('/admin/des')) {
    return { module: 'avaliacao-trimestral-des', anchor: 'visao-geral-do-programa-des' };
  }

  // Negociação Paralela module
  if (pathname.startsWith('/admin/reposicao/negociacao-paralela')) {
    return { module: 'negociacao-paralela', anchor: 'ranking-de-candidatos' };
  }

  // Eventos Comerciais module (Reposição)
  if (pathname.startsWith('/admin/reposicao/promocoes')) {
    return { module: 'eventos-comerciais', anchor: 'promoções' };
  }
  if (pathname.startsWith('/admin/reposicao/aumentos')) {
    return { module: 'eventos-comerciais', anchor: 'aumentos-anunciados' };
  }
  if (pathname.startsWith('/admin/reposicao/oportunidades')) {
    return { module: 'eventos-comerciais', anchor: 'oportunidades-unificadas' };
  }
  if (pathname.startsWith('/admin/reposicao/pedidos')) {
    return { module: 'eventos-comerciais', anchor: 'ciclo-de-oportunidade' };
  }
  if (pathname.startsWith('/admin/reposicao')) {
    return { module: 'eventos-comerciais', anchor: 'visão-geral' };
  }

  return { module: 'eventos-comerciais', anchor: 'visão-geral' };
}

/**
 * Backwards-compatible helper that returns just the anchor for a route.
 * @deprecated use getHelpMappingForRoute to get both module and anchor.
 */
export function getHelpAnchorForRoute(pathname: string): string {
  return getHelpMappingForRoute(pathname).anchor;
}

/**
 * Available help modules (one per file under src/content/help/).
 */
export interface HelpModule {
  slug: string;
  title: string;
  content: string;
}

