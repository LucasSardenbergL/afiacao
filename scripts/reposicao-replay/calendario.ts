// Calendários do replay (spec §5.9 "Calendário"). Seg–sex, sem feriados (como `public.dias_uteis_entre`).
// Dois calendários: (1) LT e revisão = só dias úteis, gerados explicitamente (nunca via `dias_uteis_entre(d, d+1)`,
// que devolve 0 para a sexta); (2) dias de atendimento = dias úteis ∪ dias com venda efetiva (sábado com NF).
// Este módulo é o ÚNICO dono de `duEntre` (absorveu o antigo du.ts).
import { addDias, diffDias, ehDiaUtil } from '../../src/lib/reposicao/orcamento-compra/datas';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import type { Dados, Data } from './tipos';

/** Nº de dias úteis em (a, b]: EXCLUI o dia inicial, INCLUI o final (convenção de `dias_uteis_entre`). b <= a => 0. */
export function duEntre(a: Data, b: Data): number {
  const n = diffDias(a, b);
  let du = 0;
  for (let i = 1; i <= n; i++) if (ehDiaUtil(addDias(a, i))) du++;
  return du;
}

/** Dias úteis (seg–sex) em [inicio, fim], ambos inclusos, em ordem. fim < inicio => []. */
export function diasUteis(inicio: Data, fim: Data): Data[] {
  const out: Data[] = [];
  const n = diffDias(inicio, fim);
  for (let i = 0; i <= n; i++) {
    const d = addDias(inicio, i);
    if (ehDiaUtil(d)) out.push(d);
  }
  return out;
}

/**
 * Dias de atendimento de INICIO_AQUECIMENTO até o fim da avaliação: dias úteis ∪ dias com venda efetiva no escopo
 * (sábado/domingo com NF). Ordenados e sem repetição.
 */
export function diasAtendimento(dados: Pick<Dados, 'vendas'>): Data[] {
  const ini = INICIO_AQUECIMENTO;
  const fim = JANELAS.avaliacaoFim;
  const conj = new Set<Data>(diasUteis(ini, fim));
  for (const v of dados.vendas) if (v.noEscopo && v.data >= ini && v.data <= fim) conj.add(v.data);
  return [...conj].sort();
}

/**
 * Soma `n` dias úteis a `d`. n >= 0: avança para o n-ésimo dia útil estritamente depois de `d` (n = 0 devolve `d`
 * mesmo em fim de semana); n < 0 retrocede. De sexta, +1 = segunda; de sábado, +1 = segunda.
 */
export function somarDiasUteis(d: Data, n: number): Data {
  const passo = n >= 0 ? 1 : -1;
  let resto = Math.abs(n);
  let cur = d;
  while (resto > 0) {
    cur = addDias(cur, passo);
    if (ehDiaUtil(cur)) resto--;
  }
  return cur;
}
