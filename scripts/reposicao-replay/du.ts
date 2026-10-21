// Dias úteis (seg–sex, sem feriados), mesma convenção de `dias_uteis_entre`: EXCLUI o dia inicial, INCLUI o final.
// Helper mínimo; a Task 3 (calendario.ts) pode absorvê-lo. Reaproveita a aritmética de datas do orçamento de compra.
import { addDias, diffDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import type { Data } from './tipos';

/** Nº de dias úteis em (a, b]. b <= a => 0. */
export function duEntre(a: Data, b: Data): number {
  const n = diffDias(a, b);
  let du = 0;
  for (let i = 1; i <= n; i++) if (ehDiaUtil(addDias(a, i))) du++;
  return du;
}
