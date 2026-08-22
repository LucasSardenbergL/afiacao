import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Gate estrutural da classe "teste negativo verde que não assere nada".
//
// A classe: `expect(...).toThrow()` SEM argumento passa com QUALQUER exceção — inclusive um
// `TypeError` vindo de um typo no dublê, de um mock que mudou de forma, ou de um refactor que
// quebrou o caminho ANTES de chegar no guard. O teste continua verde e a invariante que ele
// dizia proteger sumiu sem ninguém notar. É o gêmeo exato do `WHEN OTHERS THEN 'OK'` que o
// CLAUDE.md já proíbe em teste negativo de SQL, só que em TypeScript.
//
// MEDIDO (2026-08-22, `scripts/mutcheck.sh` sobre `fetchAllPages` × o consumidor
// `getAnaliseDimensional.test.ts`, dois FAIL-CLOSED de money-path):
//
//   mutação                                        antes (pelado)   depois (casa a marca)
//   ramo data:null lança TypeError, não a falha     ⚠ SOBREVIVE      ✓ PEGA
//   guard assina o `motivo` ERRADO                  ⚠ SOBREVIVE      ✓ PEGA
//   controle+ (trunca na 1ª página)                 ✓ PEGA           ✓ PEGA
//
// 1/3 → 3/3, com baseline verde e controle+ válido nas duas rodadas. Detalhe:
// `docs/historico/tothrow-pelado.md`.
//
// `not.toThrow()` é LEGÍTIMO e fica de fora: ali não há erro a especificar — a asserção é a
// ausência de throw, e ela já é completa.
//
// Por que o stripper COMPARTILHADO e não um regex local: no dia em que este gate nasceu,
// 3 das ocorrências restantes no repo viviam DENTRO de comentário — uma delas é a linha que
// documenta esta própria regra (`postgrest.test.ts`). Um regex ingênuo acusaria a documentação
// da lição como violação dela. `removerComentarios` entende string/template/regex e preserva a
// numeração de linha, então o relatório abaixo aponta a linha real do arquivo.
//
// LIMITE CONHECIDO, declarado de propósito: o `assertThrows`/`assertRejects` das edges Deno NÃO
// é coberto — lá a checagem seria por ARIDADE (2º argumento presente), e os helpers de hoje em
// `supabase/functions/**/*_test.ts` são locais e já exigem a mensagem. Se um dia passarem a
// aceitar chamada de 1 argumento, este gate precisa crescer; ele não cobre esse flanco agora.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src', 'supabase/functions', 'scripts'];
const ARQ_TESTE = /(\.(test|spec)\.tsx?|_test\.tsx?)$/;

/** `.toThrow()` / `.toThrowError()` sem nada dentro. O `not.` sai antes, na limpeza. */
const PELADO = /\.(toThrow|toThrowError)\(\s*\)/;
const COM_NOT = /\.not\s*\.\s*(toThrow|toThrowError)\(\s*\)/g;

function listarTestes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    if (statSync(resolve(RAIZ, rel)).isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarTestes(rel, acc);
    } else if (ARQ_TESTE.test(nome)) {
      acc.push(rel);
    }
  }
  return acc;
}

describe('gate: asserção negativa diz QUAL erro espera', () => {
  const arquivos = DIRS.flatMap((d) => listarTestes(d));

  it('o walker anda de verdade', () => {
    // Sem esta âncora, um walker que devolve [] passa o gate por vacuidade — o "verde por
    // ausência de dado" que este repo já pagou caro em outros gates.
    expect(arquivos.length).toBeGreaterThan(300);
    expect(arquivos).toContain(join('src', 'lib', '__tests__', 'postgrest.test.ts'));
  });

  it('nenhum `toThrow()` pelado — o erro esperado tem de estar escrito', () => {
    const violacoes: string[] = [];
    for (const rel of arquivos) {
      const limpo = removerComentarios(readFileSync(resolve(RAIZ, rel), 'utf8'));
      limpo
        .replace(COM_NOT, '')
        .split('\n')
        .forEach((linha, i) => {
          if (PELADO.test(linha)) violacoes.push(`${rel}:${i + 1}`);
        });
    }
    expect(
      violacoes,
      'passa com QUALQUER exceção (um TypeError do dublê inclusive) e a invariante some em ' +
        'silêncio. Diga o que espera: `.toThrow(/trecho da mensagem do RAMO/)`, ou melhor, ' +
        'case a MARCA estrutural do erro (ex.: `ehFalhaDePagina(e)` + `e.motivo`). ' +
        'Ver docs/historico/tothrow-pelado.md',
    ).toEqual([]);
  });
});
