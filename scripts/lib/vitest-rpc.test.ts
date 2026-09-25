/**
 * Suite PURA do classificador. As formas abaixo NAO foram inventadas: sairam do `vitest run` 3.2.6
 * real deste repo, num fixture descartavel, capturadas em arquivo (ver secao do #2533 em
 * `docs/historico/exclusividade-media-outra-coisa.md`).
 *
 * Todo cenario de `RPC-SEM-DADO` tem o par que precisa continuar `REPROVA` — a classificacao so
 * vale se ela AINDA engole vermelho de verdade.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENV_DO_MOTOR } from './exclusividade';
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

/**
 * A forma COLORIDA — a que o motor realmente produz. Copiada BYTE A BYTE do `vitest run` 3.2.6 sob
 * `ENV_DO_MOTOR` (so o denominador foi trocado para passar o piso). A 1a versao desta guarda so
 * conhecia a forma sem cor e caiu em REPROVA no baseline real: com o ANSI, o `Error:` nao fica na
 * coluna 0 e o resumo nao casa.
 */
const E = '\x1b';
const linhaCor = (rotulo: string, meio: string, total: string) =>
  `${E}[2m ${rotulo} ${E}[22m ${E}[1m${E}[32m${meio}${E}[39m${E}[22m${E}[90m (${total})${E}[39m`;
const VERDE_COR = [
  linhaCor('Test Files', '842 passed', '842'),
  linhaCor('     Tests', '9256 passed', '9256'),
  `${E}[2m     Errors ${E}[22m ${E}[1m${E}[31m1 error${E}[39m${E}[22m`,
  '',
].join('\n');
const CORPO_RPC_COR = `${E}[31m${E}[1mError${E}[22m: [vitest-worker]: Timeout calling "onTaskUpdate"${E}[39m\n`;

describe('classificarVermelho — a saida COLORIDA que o motor produz', () => {
  it('RPC colorido => RPC-SEM-DADO (a forma que derrubou a 1a versao no baseline real)', () => {
    expect(VERDE_COR).toContain(`${E}[`); // a fixture exercita MESMO o caminho com cor
    expect(classificarVermelho(VERDE_COR, CORPO_RPC_COR).classe).toBe('RPC-SEM-DADO');
  });

  it('teste falhando colorido continua REPROVA — tirar a cor nao engole a falha', () => {
    const falhando = VERDE_COR.replace('842 passed', '1 failed | 841 passed').replace('9256 passed', '1 failed | 9255 passed');
    expect(classificarVermelho(falhando, CORPO_RPC_COR).classe).toBe('REPROVA');
  });

  it('lerResumoVitest le o resumo colorido', () => {
    expect(lerResumoVitest(VERDE_COR)).toEqual({ arquivos: { total: 842, falharam: 0 }, testes: { total: 9256, falharam: 0 } });
  });
});

/**
 * PARIDADE: o vitest REAL, sob `ENV_DO_MOTOR`, num fixture descartavel. E o eixo POR FORA que faltou —
 * as fixtures acima sao copias, e copia envelhece quando o vitest muda a cor; este roda a ferramenta.
 * O ambiente e minimo (PATH/HOME + `ENV_DO_MOTOR`) de proposito: dentro do vitest o `process.env`
 * carrega VITEST_*, e herda-lo mediria o vitest-dentro-do-vitest, nao o gate do motor.
 */
describe('classificarVermelho — PARIDADE com o vitest real sob o ambiente do motor', () => {
  const VITEST = resolve('node_modules/.bin/vitest');
  const rodarFixture = (corpo: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-rpc-paridade-'));
    try {
      writeFileSync(join(dir, 'ok.test.ts'), "import { it, expect } from 'vitest';\nit('passa', () => { expect(1).toBe(1); });\n");
      writeFileSync(join(dir, 'rpc.test.ts'), corpo);
      const r = spawnSync(VITEST, ['run', '--root', dir], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...ENV_DO_MOTOR },
      });
      return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // O texto do RPC montado em pedacos: literal inteiro aqui viraria "1 RPC" no code-frame DESTE arquivo.
  const REJEITA_RPC = "const m = ['[vitest', '-worker]: Timeout calling \"onTaskUpdate\"'].join('');\nPromise.reject(new Error(m));\n";

  it('RPC real, todos passando => RPC-SEM-DADO — e a saida VEIO colorida (senao o teste nao prova nada)', () => {
    const r = rodarFixture(`import { it, expect } from 'vitest';\n${REJEITA_RPC}it('passa', () => { expect(1).toBe(1); });\n`);
    expect(r.rc).toBe(1);
    expect(r.stdout + r.stderr).toContain('\x1b[');
    // O piso e o da suite deste repo; o fixture tem 2 arquivos — a paridade testada aqui e a do FORMATO.
    expect(classificarVermelho(r.stdout, r.stderr, { arquivos: 2, testes: 2 }).classe).toBe('RPC-SEM-DADO');
  }, 130_000);

  it('teste falhando real + RPC => REPROVA', () => {
    const r = rodarFixture(`import { it, expect } from 'vitest';\n${REJEITA_RPC}it('falha', () => { expect(1).toBe(2); });\n`);
    expect(r.rc).toBe(1);
    expect(r.stdout + r.stderr).toContain('\x1b[');
    expect(classificarVermelho(r.stdout, r.stderr, { arquivos: 2, testes: 2 }).classe).toBe('REPROVA');
  }, 130_000);
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
