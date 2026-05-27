export interface OmieClientePagina {
  codigo_cliente_omie: number;
  razao_social?: string | null;
  nome_fantasia?: string | null;
  cnpj_cpf?: string | null;
  codigo_vendedor?: number | null;
  cidade?: string | null;
  estado?: string | null;
}

/** Clientes da página que NÃO estão no set de vinculados. Normaliza codigo a Number nos dois lados. */
export function computeNaoVinculados(
  pagina: OmieClientePagina[],
  linkedCodigos: Set<number>,
): OmieClientePagina[] {
  return pagina.filter((c) => !linkedCodigos.has(Number(c.codigo_cliente_omie)));
}
