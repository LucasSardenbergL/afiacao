import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  analisar,
  classificarArgumentos,
  descobrirVinculosShell,
  repassaArgumentosOpacos,
} from './lib/psql-ro-error-stop';
import { PISOS, RAIZES_PADRAO, enumerar } from './psql-ro-error-stop-gate';
import { removerComentariosShell } from '@/lib/gates/limpeza-shell';

/**
 * Dente do fiscal de `psql-ro` + `ON_ERROR_STOP` (docs/historico/psql-ro-exit-zero-em-sql-que-
 * falhou.md). Roda no CI por `bun run test` — puramente textual, sem credencial de banco.
 *
 * As fixtures são ARQUIVOS de verdade em `scripts/fixtures/psql-ro-error-stop/`, com a
 * expectativa no nome (`viola-*` / `limpo-*`), e são os MESMOS bytes que
 * `scripts/falsificar-psql-ro-error-stop.sh` materializa em tmp para rodar o CLI nos dois locales
 * e sabotar uma camada por vez. Fixture duplicada entre os dois consumidores desanda; esta não.
 */

// `import.meta.dir` é do Bun e não existe no vitest — `import.meta.url` existe nos dois.
const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const DIR_FIXTURES = resolve(RAIZ, 'scripts/fixtures/psql-ro-error-stop');

function fixtura(nome: string) {
  const caminho = resolve(DIR_FIXTURES, nome);
  return { caminho: nome.replace(/\.fixture$/, ''), fonte: readFileSync(caminho, 'utf8') };
}

const NOMES = readdirSync(DIR_FIXTURES).filter((n) => n.endsWith('.fixture')).sort();

describe('fixtures — cada uma isola UMA camada', () => {
  it('a coleção existe e tem os dois lados (sem par positivo, "recusa tudo" passaria)', () => {
    expect(NOMES.filter((n) => n.startsWith('viola-')).length).toBeGreaterThanOrEqual(10);
    expect(NOMES.filter((n) => n.startsWith('limpo-')).length).toBeGreaterThanOrEqual(8);
  });

  it.each(NOMES)('%s', (nome) => {
    const esperaViolacao = nome.startsWith('viola-');
    const r = analisar([fixtura(nome)]);
    expect(r.violacoes.length > 0).toBe(esperaViolacao);
  });
});

describe('discriminações que precisam ser POSITIVAS, não sorte', () => {
  it('o psql LOCAL de PG17 (`$PGBIN/psql`) não gera sítio nenhum', () => {
    const r = analisar([fixtura('limpo-d-pgbin-e-outro-binario.sh.fixture')]);
    expect(r.sitios).toHaveLength(0);
  });

  it('a variável dentro de literal é PROSA e não conta como sítio', () => {
    const r = analisar([fixtura('limpo-f-prosa-com-a-variavel.sh.fixture')]);
    // Só a invocação real de `-Atc` sobra; as duas menções em mensagem e o `[ -x ]` saem.
    expect(r.sitios).toHaveLength(1);
    expect(r.sitios[0].temC).toBe(true);
  });

  it('atribuição local REFUTA o nome semente', () => {
    const fonte = 'PGBIN=/opt/pg/bin\nPSQL="$PGBIN/psql"\n';
    expect(descobrirVinculosShell(fonte).has('PSQL')).toBe(false);
  });

  it('o nome semente vale quando o arquivo NÃO o define (vem do ambiente)', () => {
    expect(descobrirVinculosShell('"$PSQL_RO" -f q.sql\n').has('PSQL_RO')).toBe(true);
  });

  it('alias por atribuição é propagado por ponto-fixo', () => {
    const fonte = 'W="$HOME/.config/afiacao/psql-ro"\nW2="$W"\nW3="$W2"\n';
    const v = descobrirVinculosShell(fonte);
    expect([v.has('W'), v.has('W2'), v.has('W3')]).toEqual([true, true, true]);
  });
});

describe('classificação de argumentos — a leitura das formas do psql', () => {
  const p = (...palavras: string[]) => palavras.map((cru) => ({ cru, prefixoNu: cru }));

  it('reconhece `-c` em cluster e na forma longa; `-F` maiúsculo NÃO é `-f`', () => {
    expect(classificarArgumentos(p('-Atc', 'SELECT 1')).temC).toBe(true);
    expect(classificarArgumentos(p('--command=SELECT 1')).temC).toBe(true);
    expect(classificarArgumentos(p('-At', '-F', '|')).temC).toBe(false);
    expect(classificarArgumentos(p('-At', '-F', '|')).temF).toBe(false);
  });

  it('lê ON_ERROR_STOP separado, colado e nas formas longas — e respeita o VALOR', () => {
    expect(classificarArgumentos(p('-v', 'ON_ERROR_STOP=1')).temErrorStop).toBe(true);
    expect(classificarArgumentos(p('-vON_ERROR_STOP=on')).temErrorStop).toBe(true);
    expect(classificarArgumentos(p('--set=ON_ERROR_STOP=true')).temErrorStop).toBe(true);
    expect(classificarArgumentos(p('--variable', 'ON_ERROR_STOP=1')).temErrorStop).toBe(true);
    expect(classificarArgumentos(p('-v', 'ON_ERROR_STOP=off')).temErrorStop).toBe(false);
    expect(classificarArgumentos(p('-v', 'ON_ERROR_STOP=0')).temErrorStop).toBe(false);
    // Nome de variável do psql é case-sensitive: `on_error_stop` NÃO liga nada.
    expect(classificarArgumentos(p('-v', 'on_error_stop=1')).temErrorStop).toBe(false);
    // A forma colada vale só para `-v`: liberá-la para `f` faria `-vfoo=1` casar como `--file`.
    expect(classificarArgumentos(p('-vfoo=1')).temF).toBe(false);
  });

  it('repasse opaco é `"$@"`, `$*` e expansão de array', () => {
    expect(repassaArgumentosOpacos(p('"$@"'))).toBe(true);
    expect(repassaArgumentosOpacos(p('"${ARGS[@]}"'))).toBe(true);
    expect(repassaArgumentosOpacos(p('-tA', '-c', '"$1"'))).toBe(false);
  });
});

describe('a regressão do #2167 — o fiscal pega o bug que o originou', () => {
  it('`"$PSQL" -tA -f "$SQL_FILE"` sem ON_ERROR_STOP é violação', () => {
    const r = analisar([{ caminho: 'x.sh', fonte: 'PSQL="$HOME/.config/afiacao/psql-ro"\nRAW="$("$PSQL" -tA -f "$SQL_FILE")"\n' }]);
    expect(r.violacoes).toHaveLength(1);
    expect(r.violacoes[0].temF).toBe(true);
    expect(r.violacoes[0].temErrorStop).toBe(false);
  });

  it('a MESMA linha com `-v ON_ERROR_STOP=1` passa — a correção real do #2167', () => {
    const r = analisar([{ caminho: 'x.sh', fonte: 'PSQL="$HOME/.config/afiacao/psql-ro"\nRAW="$("$PSQL" -v ON_ERROR_STOP=1 -tA -f "$SQL_FILE")"\n' }]);
    expect(r.violacoes).toHaveLength(0);
    expect(r.sitios[0].precisaErrorStop).toBe(true);
  });
});

describe('o corpo REAL do repo', () => {
  const arquivos = enumerar(RAIZES_PADRAO, RAIZ).map((c) => ({
    caminho: relative(RAIZ, c),
    fonte: readFileSync(c, 'utf8'),
  }));
  const r = analisar(arquivos);

  it('nenhuma invocação lê de -f/stdin sem ON_ERROR_STOP', () => {
    expect(r.violacoes.map((v) => `${v.arquivo}:${v.linha}`)).toEqual([]);
  });

  /**
   * DENOMINADOR. Sem isto, "0 violações" com o walker quebrado é indistinguível de "0 violações"
   * por mérito — a assinatura de falha mais cara que existe num fiscal. Os números são medidos,
   * não desejados; piso é alarme de fumaça e sobe quando o repo crescer, nunca desce para caber.
   */
  it('o fiscal MEDIU: piso de arquivos, de vínculos e de sítios', () => {
    expect(r.arquivosLidos).toBeGreaterThanOrEqual(PISOS.arquivos);
    expect(r.arquivosComVinculo).toBeGreaterThanOrEqual(PISOS.arquivosComVinculo);
    expect(r.sitios.length).toBeGreaterThanOrEqual(PISOS.sitios);
  });

  it('o censo bate com o histórico: 14 consumidores executam o wrapper', () => {
    // O doc do #2167 contou 14 varrendo à mão "quem EXECUTA" (≠ as 200+ menções em prosa).
    // Se esta conta divergir, ou nasceu consumidor novo (atualize) ou o fiscal ficou cego.
    expect(r.arquivosComVinculo).toBe(14);
  });

  it('o único sítio que precisa de ON_ERROR_STOP por `-f` é o do #2167, e ele tem', () => {
    const porArquivo = r.sitios.filter((s) => s.temF);
    expect(porArquivo.map((s) => s.arquivo)).toEqual(['db/audit-anon-dml-bypass.sh']);
    expect(porArquivo[0].temErrorStop).toBe(true);
  });

  it('o stripper shell não desabou em nenhum `.sh` (fração, bloco e sub-limpeza)', async () => {
    const { comentariosSobreviventes, heredocsAbertos, maiorBlocoDescartadoShell, medirPreservacaoShell } =
      await import('@/lib/gates/limpeza-shell');
    const sh = arquivos.filter((a) => /\.(sh|bash)$/.test(a.caminho));
    expect(sh.length).toBeGreaterThanOrEqual(300);
    for (const a of sh) {
      const { fracao, linhasOriginais } = medirPreservacaoShell(a.fonte);
      if (linhasOriginais >= 20) expect(`${a.caminho}:${fracao >= PISOS.preservacaoShell}`).toBe(`${a.caminho}:true`);
      expect(`${a.caminho}:${maiorBlocoDescartadoShell(a.fonte) <= PISOS.blocoDescartado}`).toBe(`${a.caminho}:true`);
      expect(`${a.caminho}:${comentariosSobreviventes(a.fonte)}`).toBe(`${a.caminho}:${PISOS.comentariosSobreviventes}`);
      // Eixo medido POR FORA da máquina: nenhum `.sh` do repo termina com heredoc aberto.
      expect(`${a.caminho}:${heredocsAbertos(a.fonte)}`).toBe(`${a.caminho}:${PISOS.heredocsAbertos}`);
    }
  });

  it('o gate mede o que documenta: as ~200 menções em prosa NÃO viram sítio', () => {
    const mencoes = arquivos.filter((a) => /psql-ro/.test(a.fonte)).length;
    expect(mencoes).toBeGreaterThan(50);
    expect(r.arquivosComVinculo).toBeLessThan(mencoes / 2);
  });
});

describe('o stripper é o COMPARTILHADO, não regex local', () => {
  it('a limpeza usada pelo gate é a de `@/lib/gates/limpeza-shell`', () => {
    const fonte = '# "$PSQL" -f q.sql\nPSQL="$HOME/.config/afiacao/psql-ro"\n"$PSQL" -Atc x\n';
    expect(removerComentariosShell(fonte).split('\n')[0]).toBe('');
    expect(analisar([{ caminho: 'x.sh', fonte }]).sitios).toHaveLength(1);
  });
});
