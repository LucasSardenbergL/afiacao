// Views do Postgres perdem o NOT NULL das colunas-base: no `types.ts` gerado TODA coluna de view é
// `| null`. O jeito antigo de lidar com isso era `(data ?? []) as unknown as Tipo[]`, que apaga a
// checagem da linha inteira (coluna renomeada, tabela errada e tipo trocado passam verdes). Aqui a
// borda EXIGE só as colunas sem as quais a linha não faz sentido (chave, status) e lança se vierem
// nulas — ausente ≠ zero (CLAUDE.md): linha inválida não entra nem vira 0/"".
//
// Nasceu em src/lib/reposicao/linha-view.ts (#3162); promovido a plataforma quando o 2º módulo
// (governança · DES) precisou do mesmo idioma.

/** `T` com as colunas `K` garantidamente não-nulas. */
export type ComColunas<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

/** Lança se alguma das `colunas` vier null/undefined; depois disso o TS enxerga `linha` estreitada. */
export function exigirColunas<T extends object, K extends keyof T>(
  linha: T,
  colunas: readonly K[],
  fonte: string,
): asserts linha is T & ComColunas<T, K> {
  for (const c of colunas) {
    if (linha[c] === null || linha[c] === undefined) {
      throw new Error(`${fonte}: coluna "${String(c)}" veio nula — linha inválida, não entra`);
    }
  }
}

/** `exigirColunas` sobre uma lista (lança na PRIMEIRA linha inválida; `null`/`undefined` = lista vazia). */
export function linhasCom<T extends object, K extends keyof T>(
  linhas: readonly T[] | null | undefined,
  colunas: readonly K[],
  fonte: string,
): ComColunas<T, K>[] {
  return (linhas ?? []).map((l) => {
    exigirColunas(l, colunas, fonte);
    return l;
  });
}
