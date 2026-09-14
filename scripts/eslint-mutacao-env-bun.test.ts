import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prova do GATE do `eslint.config.js` que barra mutar `process.env` no código que roda sob bun
 * (docs/historico/bun-filho-sem-env-herda-a-partida.md). Sob bun, filho aberto por
 * `spawnSync`/`execSync`/`execFileSync`/`Bun.spawn*` sem `env` recebe o ambiente da PARTIDA e a
 * mutação some em silêncio — e este arquivo roda no vitest (node), onde ela chegaria. Por isso o que
 * se prova aqui é o LINT, não o comportamento.
 *
 * Contra verde por cegueira: (1) casa a MARCA da mensagem da regra, não "algum erro"; (2) fixture que
 * não parseia LANÇA — parse error devolve zero violações, idêntico a "limpo"; (3) as linhas pegas são
 * conferidas uma a uma, então um seletor quebrado some da lista em vez de se esconder numa contagem.
 */

/** Fecho da mensagem da regra: ASCII e caixa fixa, para o casamento não depender de locale. */
const MARCA = 'bun-filho-sem-env-herda-a-partida';
const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: RAIZ });

async function linhasPegas(codigo: string, relativo: string): Promise<number[]> {
  const [resultado] = await eslint.lintText(codigo, { filePath: join(RAIZ, relativo) });
  const fatal = resultado.messages.find((m) => m.fatal);
  if (fatal) {
    throw new Error(
      `a fixture de ${relativo} não parseou (${fatal.message}) — zero violação aqui seria cegueira, não limpeza`,
    );
  }
  return resultado.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes(MARCA))
    .map((m) => m.line);
}

/** Uma forma de mutação por linha; todas são JS válido, para a mesma fixture servir a `.ts` e `.mjs`. */
const MUTACOES = [
  "process.env.GIT_CONFIG_GLOBAL = '/tmp/hostil';",
  "process.env['GIT_DIR'] = '/tmp/repo';",
  "process.env.PATH += ':/opt/bin';",
  "process.env.TZ ??= 'UTC';",
  'delete process.env.GIT_TRACE;',
  "delete process.env['HOME'];",
  "Object.assign(process.env, { A: '1' });",
  "Object.defineProperty(process.env, 'B', { value: '2' });",
  "Reflect.set(process.env, 'C', '3');",
  "Reflect.deleteProperty(process.env, 'D');",
  "Bun.env.E = '5';",
  'process.env = { ...process.env };',
].join('\n');
const TODAS_AS_LINHAS = MUTACOES.split('\n').map((_, i) => i + 1);

/** O idioma certo: ler, comparar, e montar uma CÓPIA que vai explícita como `env`. */
const LEITURAS_E_COPIAS = [
  "import { spawnSync } from 'node:child_process';",
  'const lido = process.env.GIT_CONFIG_GLOBAL;',
  "if (process.env.CI === 'true' || process.env.X !== undefined) console.log(lido);",
  "const env = { ...process.env, GIT_CONFIG_GLOBAL: '/tmp/hostil' };",
  'delete env.GIT_TRACE;',
  "env.PATH = '/bin';",
  "Object.assign(env, { A: '1' });",
  'const copia = Object.assign({}, process.env);',
  "spawnSync('git', ['status'], { env: { ...copia, ...env } });",
].join('\n');

describe('eslint: mutar process.env no código que roda sob bun', () => {
  it('pega cada forma de mutação, linha a linha, pela marca da regra', async () => {
    expect(await linhasPegas(MUTACOES, 'scripts/fixture-bun-env.ts')).toEqual(TODAS_AS_LINHAS);
  });

  it('não pega leitura, comparação nem a cópia que vai como `env` explícito', async () => {
    expect(await linhasPegas(LEITURAS_E_COPIAS, 'scripts/fixture-bun-env.ts')).toEqual([]);
  });

  it('vale onde roda bun: db/ em TS e scripts/ em JS', async () => {
    expect(await linhasPegas(MUTACOES, 'db/lib/fixture-bun-env.ts')).toEqual(TODAS_AS_LINHAS);
    expect(await linhasPegas(MUTACOES, 'scripts/fixture-bun-env.mjs')).toEqual(TODAS_AS_LINHAS);
  });

  it('fica fora do que roda no node: *.test.ts (vitest) e src/ (frontend)', async () => {
    expect(await linhasPegas(MUTACOES, 'scripts/fixture-bun-env.test.ts')).toEqual([]);
    expect(await linhasPegas(MUTACOES, 'src/lib/fixture-bun-env.ts')).toEqual([]);
  });
});
