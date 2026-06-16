/** Tags do Omie que marcam "não é cliente de venda". Comparação case/acento-insensível. */
export const TAGS_NAO_CLIENTE = ['fornecedor', 'transportadora'] as const;

export function temTagNaoCliente(tags: string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.some((t) => (TAGS_NAO_CLIENTE as readonly string[]).includes(t.trim().toLowerCase()));
}

/**
 * Régua A (founder, 2026-06-15): sai da carteira quem tem tag fornecedor/transportadora
 * E NÃO tem venda real (pedido válido) E NÃO foi curado como exceção. "Tem pedido = cliente, fica."
 */
export function deveExcluirDaCarteira(input: {
  tags: string[] | null | undefined;
  temVendaReal: boolean;
  isExcecao: boolean;
}): boolean {
  return temTagNaoCliente(input.tags) && !input.temVendaReal && !input.isExcecao;
}
