import type { CestaResult } from './cesta-recompra';

/**
 * Remove SKUs inativos (ativo=false no omie_products, dado já sincronizado) da cesta — codex P1:
 * não propor SKU morto. Pré-filtro PHONE-FREE; o preço FIRME/estoque ainda é validado no Omie no envio.
 */
export function filtrarCestaPorAtivos(cesta: CestaResult, ativos: Set<number>): { cesta: CestaResult; removidos: number } {
  const ativo = (sku: number) => ativos.has(sku);
  const principal = cesta.principal.filter(i => ativo(i.omie_codigo_produto));
  const secundarios = cesta.secundarios.filter(i => ativo(i.omie_codigo_produto));
  const removidos = (cesta.principal.length - principal.length) + (cesta.secundarios.length - secundarios.length);
  return { cesta: { ...cesta, principal, secundarios }, removidos };
}
