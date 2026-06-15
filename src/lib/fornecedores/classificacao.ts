/** Tags do Omie que marcam "não é cliente de venda". Comparação case/acento-insensível. */
export const TAGS_NAO_CLIENTE = ['fornecedor', 'transportadora'] as const;

export function temTagNaoCliente(tags: string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.some((t) => (TAGS_NAO_CLIENTE as readonly string[]).includes(t.trim().toLowerCase()));
}

export function deveExcluirDaCarteira(input: { tags: string[] | null | undefined; isExcecao: boolean }): boolean {
  return temTagNaoCliente(input.tags) && !input.isExcecao;
}
