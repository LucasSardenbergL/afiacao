/** Chave de uma ocorrência nas "Cores do cliente" — a MESMA no card e em quem calcula o
 *  1 toque (Fase 2A). Fora do componente para não quebrar o fast refresh. */
export function chaveOcorrenciaCor(corNome: string, indiceOcorrencia: number): string {
  return `${corNome}#${indiceOcorrencia}`;
}
