import { describe, it, expect } from 'vitest';
import { auditarBump, coletarEstado } from './sonda-versao-bump-gate';

// A história REAL do gate de bump — separada de `sonda-versao-bump-gate.test.ts` porque EXIGE histórico.
//
// Os commits abaixo são objetos do CLONE, não do código: num checkout raso (`actions/checkout` sem
// `fetch-depth: 0`) eles não existem e o `coletarEstado` lança. Morando na suíte irmã, estes testes
// deixavam VERMELHO o baseline do contrato `scripts/mutcheck.d/sonda-versao-bump-gate.mut`, que roda
// no job RASO `mutation-check` — em todo PR e em todo run da main de 2026-09-11 a 2026-09-14, com o
// contrato abortando sem medir nada. Aqui eles rodam no job `testes` (`fetch-depth: 0`), bloqueante
// como antes. MEDIDO em clone `--depth 1`: sem eles o contrato segue 14/14 mutações pegas — são
// calibração contra a história, não o dente que o `.mut` mede.
// Por que o conserto é o arquivo e não o checkout: docs/historico/teste-que-afirma-o-checkout.md.

const ALLOWLIST = 'supabase/functions/_shared/sonda-cron-alvos.ts';

describe('a história REAL — as ondas 2 a 5 passaram com o marcador do relé congelado', () => {
  // Commits squash da `main`, imutáveis. O job `testes` do CI tem `fetch-depth: 0`; história rasa
  // faz o `coletarEstado` LANÇAR (vermelho) — nunca devolver lista vazia (verde por acidente). E o
  // assert casa a LISTA INTEIRA: prova também que nenhuma outra edge dessas fatias passa a reprovar.
  const congelado = { edge: 'sonda-relay', versao: 'v1.1-alvos-da-onda-1', motivo: 'sem-bump', arquivos: [ALLOWLIST] };

  it.each([
    ['89887025b', 'onda 2 (#2388)'],
    ['d96b69f06', 'onda 3 (#2404)'],
    ['a73641e9c', 'onda 4 (#2415)'],
    ['f4578bbff', 'onda 5 (#2461)'],
  ])('%s — %s: reprova o relé, e só ele', (sha) => {
    expect(auditarBump(coletarEstado(`${sha}^`, sha))).toEqual([congelado]);
  });

  it('controle: a onda 1 (54679dc35, #2313) BUMPOU o relé → nenhum achado', () => {
    expect(auditarBump(coletarEstado('54679dc35^', '54679dc35'))).toEqual([]);
  });
});
