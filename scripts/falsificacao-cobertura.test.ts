import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Vigia de FORMA, irmão de `hooks-guard-cobertura.test.ts`: toda suíte `scripts/test-*.sh` que
 * tem modo `--falsificar` precisa ser EXECUTADA por `test:falsificacao` — com a flag.
 *
 * Por quê: o modo de falsificação é o que impede a suíte verde de ser verde por asserção frouxa.
 * Ele sabota o alvo com `sed`, uma regra por vez, e exige vermelho em cada sabotagem. Até
 * 2026-08-23 ele NUNCA rodou no CI (`grep -o falsificar package.json .github/workflows/*.yml` não
 * devolvia nada): só rodava quando alguém digitava à mão. Um modo que só roda à mão é o mesmo
 * "teste que existe e não roda" que a baseline de `hooks-suites-baseline.ts` proíbe — ausência de
 * dado, não aprovação. Este gate faz o esquecimento ficar vermelho em vez de silencioso.
 *
 * As duas metades importam. A 1ª (suíte coberta) pega o script novo que nasce órfão. A 2ª (a flag
 * chega ao alvo) pega o buraco mais traiçoeiro: sem `--falsificar`, o laço roda o modo NORMAL,
 * o job fica verde, e o CI parece cobrir a falsificação enquanto só repete o `test:hooks`.
 */

const RAIZ = join(import.meta.dirname, '..');

/** A guarda de flag que liga o modo, como os scripts a escrevem: `if [ "${1:-}" = "--falsificar" ]`. */
const GUARDA = /\[\s*"\$\{1:-\}"\s*=\s*"--falsificar"\s*\]/;

/** Suítes em `scripts/` que ACEITAM `--falsificar` (têm a guarda, não só citam a palavra). */
export function suitesComModo(arquivos: string[], ler: (f: string) => string): string[] {
  return arquivos.filter((f) => /^test-.+\.sh$/.test(f) && GUARDA.test(ler(f))).sort();
}

/**
 * Expande `for VAR in a b c; do ... scripts/test-$VAR.sh --falsificar ... done` para os arquivos
 * que o laço executa PASSANDO a flag. Um laço sem `--falsificar` no corpo devolve lista vazia —
 * é assim que a 2ª metade do gate fica vermelha em vez de aprovar o modo normal.
 */
export function alvosFalsificados(cmd: string): string[] {
  const achados: string[] = [];
  const laco = /for\s+(\w+)\s+in\s+([^;]+);\s*do\b([\s\S]*?)\bdone\b/g;
  for (const [, variavel, lista, corpo] of cmd.matchAll(laco)) {
    const cifra = `\\$\\{?${variavel}\\}?`;
    // o `.sh` e a flag têm de estar na MESMA invocação: `bash scripts/test-$t.sh --falsificar`
    const molde = new RegExp(
      `scripts/([A-Za-z0-9_.-]*${cifra}[A-Za-z0-9_.-]*\\.sh)\\s+--falsificar\\b`,
      'g',
    );
    for (const [, template] of corpo.matchAll(molde)) {
      for (const alvo of lista.trim().split(/\s+/).filter(Boolean)) {
        achados.push(template.replace(new RegExp(cifra), alvo));
      }
    }
  }
  return [...new Set(achados)].sort();
}

describe('alvosFalsificados — parser', () => {
  it('expande o laço e devolve os arquivos que recebem a flag', () => {
    expect(
      alvosFalsificados('for t in a b; do bash scripts/test-$t.sh --falsificar || exit 1; done'),
    ).toEqual(['test-a.sh', 'test-b.sh']);
  });

  it('laço SEM a flag não conta — é o modo normal disfarçado de falsificação', () => {
    expect(alvosFalsificados('for t in a b; do bash scripts/test-$t.sh || exit 1; done')).toEqual(
      [],
    );
  });

  it('a flag tem de estar na MESMA invocação, não em outro comando do corpo', () => {
    expect(
      alvosFalsificados('for t in a; do bash scripts/test-$t.sh; echo --falsificar; done'),
    ).toEqual([]);
  });
});

describe('cobertura do modo --falsificar', () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const arquivos = readdirSync(join(RAIZ, 'scripts'));
  const ler = (f: string) => readFileSync(join(RAIZ, 'scripts', f), 'utf8');

  const comModo = suitesComModo(arquivos, ler);
  const falsificados = alvosFalsificados(pkg.scripts['test:falsificacao'] ?? '');

  it('o script test:falsificacao existe (sem ele o job do CI não roda nada)', () => {
    expect(
      pkg.scripts['test:falsificacao'],
      'Faltou o script "test:falsificacao" no package.json — o job `falsificacao` do ci.yml o chama.',
    ).toBeTruthy();
  });

  it('o detector não casou com NADA — falsifica um regex que parou de casar', () => {
    expect(
      comModo.length,
      'Nenhuma suíte com `--falsificar` foi detectada. Ou o modo sumiu do repo, ou a GUARDA ' +
        'deste arquivo parou de casar a forma que os scripts usam — que deixaria o gate verde por cegueira.',
    ).toBeGreaterThan(0);
  });

  it('toda suíte com modo --falsificar roda no test:falsificacao', () => {
    const orfas = comModo.filter((f) => !falsificados.includes(f));
    expect(
      orfas,
      `Suíte(s) com modo de falsificação que NINGUÉM roda: ${orfas.join(', ')}. ` +
        `Acrescente ao \`for t in ...\` do script "test:falsificacao" no package.json. ` +
        `Modo que só roda à mão é ausência de dado: a asserção pode afrouxar sem nada ficar vermelho.`,
    ).toEqual([]);
  });

  it('o laço passa --falsificar de verdade (sem a flag ele só repete o test:hooks)', () => {
    expect(
      falsificados.length,
      'O laço de "test:falsificacao" não passa `--falsificar` a alvo nenhum. Assim ele roda o modo ' +
        'NORMAL, fica verde e o CI parece cobrir a falsificação sem sabotar uma regra sequer.',
    ).toBeGreaterThan(0);
  });

  it('nenhum alvo FANTASMA — todo arquivo citado no laço existe', () => {
    const fantasmas = falsificados.filter((f) => !arquivos.includes(f));
    expect(
      fantasmas,
      `O laço cita arquivo(s) inexistente(s): ${fantasmas.join(', ')}. ` +
        `O \`bash\` de um caminho inexistente sai 127 e derruba o job.`,
    ).toEqual([]);
  });

  it('nenhum alvo do laço é SEM MODO — receberia a flag e a ignoraria, rodando o modo normal', () => {
    const semModo = falsificados.filter((f) => arquivos.includes(f) && !GUARDA.test(ler(f)));
    expect(
      semModo,
      `Estas estão no laço mas não têm a guarda de \`--falsificar\`: ${semModo.join(', ')}. ` +
        `Um script sem o modo ignora a flag e roda o modo normal — verde que não sabotou nada.`,
    ).toEqual([]);
  });
});
