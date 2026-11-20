/**
 * Item ativo da navegação lateral: vence o PREFIXO MAIS LONGO.
 *
 * Antes era `pathname.startsWith(path)` por item, então `/sales/new` acendia
 * "Novo pedido" (`/sales/new`) E "Pedidos" (`/sales`) ao mesmo tempo — e
 * `/salesforce` acenderia "Pedidos". Aqui o casamento é por SEGMENTO (`/sales`
 * casa `/sales` e `/sales/123`, não `/salesforce`) e, entre os itens que casam,
 * só o de path mais longo fica ativo.
 */
export function casaPorSegmento(pathname: string, path: string): boolean {
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function itemNavAtivo(pathname: string, path: string, todosPaths: readonly string[]): boolean {
  if (!casaPorSegmento(pathname, path)) return false;
  return !todosPaths.some((outro) => outro.length > path.length && casaPorSegmento(pathname, outro));
}
