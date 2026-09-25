/**
 * Suite PURA do classificador. As formas abaixo NAO foram inventadas: sairam do `vitest run` 3.2.6
 * real deste repo, num fixture descartavel, capturadas em arquivo (ver secao do #2533 em
 * `docs/historico/exclusividade-media-outra-coisa.md`).
 *
 * Todo cenario de `RPC-SEM-DADO` tem o par que precisa continuar `REPROVA` — a classificacao so
 * vale se ela AINDA engole vermelho de verdade.
 */
import { describe, expect, it } from 'vitest';

import { classificarVermelho, lerResumoVitest, PISO_ARQUIVOS, PISO_TESTES } from './vitest-rpc';

/** O resumo como o vitest 3.2.6 imprime, sem cor (o motor forca `FORCE_COLOR=0`). */
const resumo = (arquivos: string, testes: string, erros?: number) =>
  [
    ' ✓ algum.test.ts (3 tests) 4ms',
    ``,
    ` Test Files  ${arquivos}`,
    `      Tests  ${testes}`,
    ...(erros === undefined ? [] : [`     Errors  ${erros} error${erros === 1 ? '' : 's'}`]),
    '   Start at  21:25:21',
    '   Duration  366ms (transform 126ms, setup 0ms, collect 126ms, tests 3ms)',
    '',
  ].join('\n');

const VERDE_842 = resumo('842 passed (842)', '9256 passed (9256)', 1);

/** O corpo do erro, como ele chega no stderr: cabecalho da secao + a linha ancorada na coluna 0. */
const CORPO_RPC = [
  '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
  '',
  'Vitest caught 1 unhandled error during the test run.',
  '',
  '⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯',
  'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
  ' ❯ processTicksAndRejections node:internal/process/task_queues:104:5',
  '',
].join('\n');

describe('classificarVermelho — o CONTROLE: a forma medida do rc=1 sob contencao', () => {
  it('resumo inteiro, zero falhando e so o RPC => RPC-SEM-DADO', () => {
    const c = classificarVermelho(VERDE_842, CORPO_RPC);
    expect(c.classe).toBe('RPC-SEM-DADO');
    expect(c.motivo).toContain('842');
  });

  it('o `[vitest-pool]` e a mesma familia (o outro lado do mesmo birpc)', () => {
    const corpo = CORPO_RPC.replace('vitest-worker', 'vitest-pool');
    expect(classificarVermelho(VERDE_842, corpo).classe).toBe('RPC-SEM-DADO');
  });

  it('2 RPC estourados com `Errors 2 errors` continuam sem dado', () => {
    const dois = resumo('842 passed (842)', '9256 passed (9256)', 2);
    expect(classificarVermelho(dois, CORPO_RPC + CORPO_RPC).classe).toBe('RPC-SEM-DADO');
  });
});

describe('classificarVermelho — o que TEM de continuar REPROVA (a falsificacao)', () => {
  it('assercao quebrada JUNTO do RPC: teste falhando manda, o RPC nao absolve', () => {
    const comFalha = resumo('1 failed | 841 passed (842)', '1 failed | 9255 passed (9256)', 1);
    const c = classificarVermelho(comFalha, CORPO_RPC);
    expect(c.classe).toBe('REPROVA');
    expect(c.motivo).toContain('falhando');
  });

  it('arquivo falhando sem teste falhando (erro de import/collect) tambem reprova', () => {
    const so = resumo('1 failed | 841 passed (842)', '9256 passed (9256)', 1);
    expect(classificarVermelho(so, CORPO_RPC).classe).toBe('REPROVA');
  });

  it('OUTRO erro real alem do RPC reprova — e mesmo enterrado LONGE do fim do canal', () => {
    const dois = resumo('842 passed (842)', '9256 passed (9256)', 2);
    const enterrado = ['Error: conexao recusada ao subir o subprocesso', 'x'.repeat(50_000), CORPO_RPC].join('\n');
    const c = classificarVermelho(dois, enterrado);
    expect(c.classe).toBe('REPROVA');
    expect(c.motivo).toContain('sobra erro real');
  });

  it('SEM linha de resumo (o `fork: Resource temporarily unavailable`) reprova — morreu antes de contar', () => {
    const morto = 'fork: Resource temporarily unavailable\n';
    const c = classificarVermelho(morto, `${morto}${CORPO_RPC}`);
    expect(c.classe).toBe('REPROVA');
    expect(c.motivo).toContain('sem linha de resumo');
  });

  it('so metade do resumo (Tests sem Test Files) reprova', () => {
    const meio = `      Tests  9256 passed (9256)\n     Errors  1 error\n`;
    expect(classificarVermelho(meio, CORPO_RPC).classe).toBe('REPROVA');
  });

  it('suite TRUNCADA (3 arquivos verdes) reprova — verde pequeno nao e verde', () => {
    const tres = resumo('3 passed (3)', '7 passed (7)', 1);
    const c = classificarVermelho(tres, CORPO_RPC);
    expect(c.classe).toBe('REPROVA');
    expect(c.motivo).toContain('piso');
  });

  it('gate COMPOSTO sem linha `Errors`: o vermelho proprio dele nao case por vacuidade (0 === 0)', () => {
    const semErros = resumo('842 passed (842)', '9256 passed (9256)');
    const c = classificarVermelho(`${semErros}\nscripts/test-x.sh: FALHOU no passo 13\n`, '');
    expect(c.classe).toBe('REPROVA');
    expect(c.motivo).toContain('nenhum');
  });

  it('a string do RPC so DENTRO de um code-frame (indentada) nao conta — a ancora e a coluna 0', () => {
    // O caso REAL: uma falha perto DESTE arquivo faz o vitest imprimir o code-frame da fixture
    // acima, e a linha citada contem o texto inteiro. Sem a ancora na coluna 0 ela viraria "1 RPC".
    // A 1a versao deste teste era TEATRO — usava `new Error('[vitest-...`, que nao contem
    // `Error: [vitest-`, entao a sabotagem da ancora sobrevivia (falsificacao de 2026-09-25).
    const frame = [
      ' \u276f scripts/lib/vitest-rpc.test.ts:31:3',
      "      30|   'Vitest caught 1 unhandled error during the test run.',",
      `      31|   'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',`,
      '',
    ].join('\n');
    expect(frame).toContain('Error: [vitest-worker]: Timeout calling "');
    expect(classificarVermelho(VERDE_842, frame).classe).toBe('REPROVA');
  });

  it('saida vazia reprova', () => {
    expect(classificarVermelho('', '').classe).toBe('REPROVA');
  });
});

describe('lerResumoVitest — a leitura do denominador', () => {
  it('le falhas, pulados e todo sem contar nenhum deles como falha', () => {
    const r = lerResumoVitest(resumo('1 failed | 1 passed (2)', '1 failed | 2 passed | 1 skipped | 1 todo (5)'));
    expect(r).toEqual({ arquivos: { total: 2, falharam: 1 }, testes: { total: 5, falharam: 1 } });
  });

  it('com varias suites na mesma captura vale a ULTIMA', () => {
    const duas = resumo('3 passed (3)', '7 passed (7)') + resumo('842 passed (842)', '9256 passed (9256)');
    expect(lerResumoVitest(duas)?.arquivos.total).toBe(842);
  });

  it('formato irreconhecivel vira null, nunca contagem otimista', () => {
    expect(lerResumoVitest(' Test Files  tudo bem (2)\n      Tests  2 passed (2)\n')).toBeNull();
  });

  it('o piso declarado e o da suite REAL deste repo, com folga para ela crescer', () => {
    expect(PISO_ARQUIVOS).toBeLessThan(842);
    expect(PISO_TESTES).toBeLessThan(9256);
  });
});
