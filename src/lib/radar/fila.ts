/**
 * "Próximo lead" da fila do Radar (pacote A1). Antes, no fim dos 50 carregados o `proximo()` caía em
 * `empresas.find(e => e.cnpj !== aberta)` — voltava ao 1º lead sem buscar a página seguinte, e o vendedor
 * re-ligava para quem já tinha falado. Agora a decisão é explícita:
 *  · há um lead depois do aberto → ele;
 *  · o aberto SAIU da lista (contato registrado, refetch) → o que ocupou a posição dele;
 *  · acabou o carregado → `buscar_mais` se há página seguinte, `fim` se a fila acabou de verdade.
 * Nunca volta ao começo.
 */
export type PassoFila<T> =
  | { tipo: 'abrir'; empresa: T; indice: number }
  | { tipo: 'buscar_mais' }
  | { tipo: 'fim' };

export function proximoDaFila<T extends { cnpj: string }>(
  fila: readonly T[],
  cnpjAberto: string,
  /** Posição do aberto na última vez em que foi visto na lista (null = nunca). */
  ultimoIndice: number | null,
  temMais: boolean,
): PassoFila<T> {
  const i = fila.findIndex((e) => e.cnpj === cnpjAberto);
  const alvo = i >= 0 ? i + 1 : ultimoIndice ?? fila.length;
  const empresa = fila[alvo];
  if (empresa && empresa.cnpj !== cnpjAberto) return { tipo: 'abrir', empresa, indice: alvo };
  return temMais ? { tipo: 'buscar_mais' } : { tipo: 'fim' };
}
