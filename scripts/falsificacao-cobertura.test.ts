import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

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

/**
 * A guarda de flag que liga o modo, como os scripts a escrevem: `if [ "${1:-}" = "--falsificar" ]`
 * — ou INVERTIDA, `if [ "${1:-}" != "--falsificar" ]` (roda o normal e cai no modo depois). A forma
 * invertida é a da `db/test-canaria-veredito.sh`, e a regex antiga (só `=`) não a casava: medido em
 * 2026-09-10, a canária era invisível a este detector também por isso, além de morar fora de
 * `scripts/`. As provas de `db/` são cobradas por outro vigia — o 3º campo do `db/nucleo-ci.txt`,
 * conferido pelo `db/roda-nucleo-ci.sh`.
 */
const GUARDA = /\[\s*"\$\{1:-\}"\s*!?=\s*"--falsificar"\s*\]/;

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

describe('GUARDA — detector do modo', () => {
  it('casa a guarda direta e a INVERTIDA (a forma da canária)', () => {
    expect(GUARDA.test('if [ "${1:-}" = "--falsificar" ]; then')).toBe(true);
    expect(GUARDA.test('if [ "${1:-}" != "--falsificar" ]; then')).toBe(true);
  });

  it('não casa quem só CITA a flag (comentário de uso, laço de outro script)', () => {
    expect(GUARDA.test('#   bash db/x.sh --falsificar  # sabota e exige vermelho')).toBe(false);
    expect(GUARDA.test('bash scripts/test-$t.sh --falsificar || exit 1')).toBe(false);
  });

  it('suitesComModo enxerga a suíte de guarda invertida', () => {
    const fontes: Record<string, string> = {
      'test-direta.sh': 'if [ "${1:-}" = "--falsificar" ]; then :; fi',
      'test-invertida.sh': 'if [ "${1:-}" != "--falsificar" ]; then exit 0; fi',
      'test-sem-modo.sh': 'echo ok',
    };
    expect(suitesComModo(Object.keys(fontes), (f) => fontes[f])).toEqual([
      'test-direta.sh',
      'test-invertida.sh',
    ]);
  });
});

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
      'Faltou o script "test:falsificacao" no package.json — o job `gates-e-falsificacao` do ci.yml o chama.',
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

/**
 * As FATIAS do CI (2026-10-18, J2 do plano de melhoria v2). O job `falsificacao` do ci.yml roda
 * `test:falsificacao:1..N` em matriz — uma fatia por runner — porque o roteiro inteiro levava
 * 15–16 min em série e era o caminho crítico do `validate`. A partição é ESTÁTICA (dois alvos
 * pesados e muitos leves não se balanceiam por posição), e estático é o que se prova aqui:
 *
 *   · a UNIÃO das fatias é exatamente o roteiro `test:falsificacao` — alvo que entra no laço
 *     inteiro e não entra em fatia nenhuma roda no laptop e NUNCA no CI (a mesma "ausência de
 *     dado" que a cobertura acima pega para o script órfão);
 *   · nenhum alvo em DUAS fatias (custo em dobro, calado);
 *   · todo comando FORA do laço do roteiro (`bun scripts/x.ts --falsificar`) está em exatamente
 *     uma fatia;
 *   · o ci.yml tem UM step por fatia, `run: bun run test:falsificacao:k` casado com
 *     `if: matrix.parte == k`, e `matrix.parte` é exatamente 1..N — parte que não roda não
 *     reprova nada, e um `if` trocado deixaria a fatia verde sem rodar.
 */
export function fatiasDoRoteiro(scripts: Record<string, string>): { k: number; nome: string; cmd: string }[] {
  return Object.keys(scripts)
    .map((nome) => ({ nome, m: /^test:falsificacao:(\d+)$/.exec(nome) }))
    .filter((x): x is { nome: string; m: RegExpExecArray } => x.m !== null)
    .map(({ nome, m }) => ({ k: Number(m[1]), nome, cmd: scripts[nome] }))
    .sort((a, b) => a.k - b.k);
}

/** Comandos fora do laço que passam a flag: `bun scripts/sonda-cron-prova.ts --falsificar`. */
export function foraDoLaco(cmd: string): string[] {
  const semLacos = cmd.replace(/for\s+\w+\s+in\s+[^;]+;\s*do\b[\s\S]*?\bdone\b/g, '');
  return [...semLacos.matchAll(/bun\s+(scripts\/[A-Za-z0-9_.-]+\.ts)\s+--falsificar\b/g)].map((m) => m[1]).sort();
}

describe('fatias do CI — a união das test:falsificacao:N é o roteiro inteiro', () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const roteiro = pkg.scripts['test:falsificacao'] ?? '';
  const fatias = fatiasDoRoteiro(pkg.scripts);

  it('há pelo menos 2 fatias, numeradas 1..N sem buraco', () => {
    expect(fatias.length).toBeGreaterThanOrEqual(2);
    expect(fatias.map((f) => f.k)).toEqual(fatias.map((_, i) => i + 1));
  });

  it('cada fatia passa --falsificar a pelo menos um alvo (fatia vazia é runner verde sem prova)', () => {
    for (const f of fatias) {
      expect(alvosFalsificados(f.cmd).length, `${f.nome} não falsifica alvo nenhum`).toBeGreaterThan(0);
    }
  });

  it('a união das fatias é exatamente o roteiro — nenhum alvo fora do CI, nenhum em duas fatias', () => {
    const porFatia = fatias.map((f) => alvosFalsificados(f.cmd));
    const uniao = porFatia.flat();
    const duplicados = uniao.filter((a, i) => uniao.indexOf(a) !== i);
    expect(duplicados, `alvo(s) em mais de uma fatia: ${duplicados.join(', ')}`).toEqual([]);
    expect([...uniao].sort(), 'união das fatias ≠ alvos do test:falsificacao').toEqual(alvosFalsificados(roteiro));
  });

  it('o que o roteiro roda FORA do laço está em exatamente uma fatia', () => {
    const esperado = foraDoLaco(roteiro);
    expect(esperado.length, 'o roteiro perdeu o comando fora do laço (sonda-cron-prova) — a asserção ficaria vazia').toBeGreaterThan(0);
    const achado = fatias.flatMap((f) => foraDoLaco(f.cmd)).sort();
    expect(achado).toEqual(esperado);
  });

  it('ci.yml: job `falsificacao` em matriz 1..N com UM step por fatia, `if` casado com o script', () => {
    const ci = parse(readFileSync(join(RAIZ, '.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { strategy?: { matrix?: { parte?: unknown } }; steps?: { run?: unknown; if?: unknown }[]; needs?: unknown }>;
    };
    const job = ci.jobs.falsificacao;
    expect(job, 'o job `falsificacao` sumiu do ci.yml').toBeTruthy();
    expect(job.strategy?.matrix?.parte).toEqual(fatias.map((f) => f.k));

    const steps = (job.steps ?? []).filter((s) => typeof s.run === 'string' && /bun run test:falsificacao/.test(s.run as string));
    expect(steps.map((s) => String(s.run).trim())).toEqual(fatias.map((f) => `bun run ${f.nome}`));
    for (const [i, s] of steps.entries()) {
      const cond = String(s.if ?? '').replace(/\$\{\{|\}\}/g, '').trim();
      expect(cond, `o step de ${fatias[i].nome} não está gateado pela parte ${fatias[i].k}`).toBe(`matrix.parte == ${fatias[i].k}`);
    }
    const needs = ci.jobs.validate?.needs;
    expect(Array.isArray(needs) && needs.includes('falsificacao'), '`falsificacao` saiu do needs do validate').toBe(true);
  });
});
