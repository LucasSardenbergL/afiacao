import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SUITES_FORA_DO_CI } from './hooks-suites-baseline';

/**
 * Vigia de FORMA, em DOIS eixos — toda suíte que existe tem de ser EXECUTADA por alguém:
 *   • EIXO 1 (`.sh`): todo `scripts/test-*.sh` roda num laço do `test:hooks`.
 *   • EIXO 2 (`.ts`): toda suíte `.ts` de `scripts/`+`db/` casa o glob do `vitest.config.ts`.
 *     (critérios DIFERENTES de propósito — o runner de cada extensão é outro; ver §EIXO 2.)
 *
 * Por quê: até 2026-08-19 existiam 7 suítes de guard e o loop rodava 5 — `destructive-bash` e
 * `migration-immutability` eram órfãs. Teste que existe e não roda é AUSÊNCIA DE DADO, não
 * aprovação: o guard podia regredir sem nada ficar vermelho. (Foi assim que o #1770 quebrou o CI —
 * o heavy-guard só passou a rodar no #1778.) Criar o script e esquecer o loop é o erro natural;
 * este teste é o que o torna impossível de passar despercebido.
 *
 * ⚠️ 2026-08-22: a versão anterior deste vigia tinha o MESMO buraco que denunciava. O `test:hooks`
 * tem DOIS laços (`test-$t-guard.sh` e `test-$t.sh`) e o vigia só lia o PRIMEIRO — a metade sem
 * sufixo `-guard` não era coberta por ninguém. Resultado: 9 suítes órfãs (inclusive
 * `test-lovable-revert-scan.sh`, que PARECIA coberta porque o `lovable-watch.yml` cita o nome
 * dela — num COMENTÁRIO; o workflow roda o script de produção, não a suíte). Daí a forma atual:
 * em vez de extrair `<x>`, o parser expande cada laço para os ARQUIVOS que ele executa e compara
 * conjunto-a-conjunto com o disco. O molde do nome sai do CORPO do laço, então um 3º laço com
 * outro padrão passa a ser coberto sozinho, sem editar este arquivo.
 */

const RAIZ = join(import.meta.dirname, '..');

/**
 * Expande os `for VAR in a b c; do ... scripts/test-$VAR....sh ... done` de um comando de shell
 * para a lista de ARQUIVOS que ele de fato executa. Lê TODOS os laços, e tira o molde do nome do
 * corpo de cada um — não presume sufixo.
 */
export function arquivosExecutados(cmd: string): string[] {
  const encontrados: string[] = [];
  const laco = /for\s+(\w+)\s+in\s+([^;]+);\s*do\b([\s\S]*?)\bdone\b/g;
  for (const [, variavel, lista, corpo] of cmd.matchAll(laco)) {
    const alvos = lista.trim().split(/\s+/).filter(Boolean);
    const cifra = `\\$\\{?${variavel}\\}?`;
    const molde = new RegExp(`scripts/([A-Za-z0-9_.-]*${cifra}[A-Za-z0-9_.-]*\\.sh)`, 'g');
    for (const [, template] of corpo.matchAll(molde)) {
      for (const alvo of alvos) {
        encontrados.push(template.replace(new RegExp(cifra), alvo));
      }
    }
  }
  return [...new Set(encontrados)].sort();
}

/** Toda suíte de shell presente no diretório `scripts/`. */
export function suitesNoDisco(arquivos: string[]): string[] {
  return arquivos.filter((f) => /^test-.+\.sh$/.test(f)).sort();
}

describe('arquivosExecutados — parser', () => {
  it('expande o laço para os arquivos, com o sufixo que estiver no corpo', () => {
    expect(
      arquivosExecutados('for t in a b c; do bash scripts/test-$t-guard.sh || exit 1; done'),
    ).toEqual(['test-a-guard.sh', 'test-b-guard.sh', 'test-c-guard.sh']);
  });

  it('lê os DOIS laços do test:hooks — foi este o buraco (o 2º não era coberto)', () => {
    expect(
      arquivosExecutados(
        'for t in a; do bash scripts/test-$t-guard.sh || exit 1; done; ' +
          'for t in x y; do bash scripts/test-$t.sh || exit 1; done',
      ),
    ).toEqual(['test-a-guard.sh', 'test-x.sh', 'test-y.sh']);
  });

  it('não presume o nome da variável nem o sufixo (um 3º laço se cobre sozinho)', () => {
    expect(
      arquivosExecutados('for suite in k; do bash scripts/test-${suite}-lento.sh; done'),
    ).toEqual(['test-k-lento.sh']);
  });

  it('devolve vazio quando o comando não tem laço (não finge cobertura)', () => {
    expect(arquivosExecutados('bun run algo-outro')).toEqual([]);
  });
});

describe('suitesNoDisco — parser', () => {
  it('pega TODO test-*.sh e ignora o resto de scripts/', () => {
    expect(
      suitesNoDisco(['test-heavy-guard.sh', 'pr-watch.sh', 'test-wt-reap.sh', 'x.test.ts']),
    ).toEqual(['test-heavy-guard.sh', 'test-wt-reap.sh']);
  });
});

// ═══ EIXO 1: suítes .sh × os laços do test:hooks ═══
describe('cobertura real: package.json x scripts/', () => {
  const pkg = JSON.parse(readFileSync(join(RAIZ, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const executados = arquivosExecutados(pkg.scripts['test:hooks'] ?? '');
  const noDisco = suitesNoDisco(readdirSync(join(RAIZ, 'scripts')));
  const baseline = SUITES_FORA_DO_CI.map((s) => s.arquivo);

  it('os laços do test:hooks não estão vazios (falsifica um regex que casou com nada)', () => {
    expect(executados.length).toBeGreaterThan(0);
  });

  it('o parser enxerga os DOIS laços (um regex só do 1º passaria sem ver metade)', () => {
    expect(executados.some((f) => f.endsWith('-guard.sh'))).toBe(true);
    expect(executados.some((f) => !f.endsWith('-guard.sh'))).toBe(true);
  });

  it('nenhuma suíte é ÓRFÃ — todo scripts/test-*.sh roda, ou está na baseline com motivo', () => {
    const orfas = noDisco.filter((f) => !executados.includes(f) && !baseline.includes(f));
    expect(
      orfas,
      `Suíte(s) que NINGUÉM roda: ${orfas.join(', ')}. ` +
        `Acrescente ao \`for t in ...\` do script "test:hooks" no package.json — ou, se de fato ` +
        `não puder rodar no runner ubuntu, a scripts/hooks-suites-baseline.ts COM o motivo.`,
    ).toEqual([]);
  });

  it('nenhum alvo dos laços é FANTASMA — todo arquivo citado existe em disco', () => {
    const fantasmas = executados.filter((f) => !noDisco.includes(f));
    expect(
      fantasmas,
      `Os laços citam arquivo(s) inexistente(s): ${fantasmas.join(', ')}. ` +
        `O \`bash\` de um caminho inexistente sai 127 e derruba o CI.`,
    ).toEqual([]);
  });

  it('burn-down: entrada da baseline que voltou a rodar sai da baseline', () => {
    const redundantes = baseline.filter((f) => executados.includes(f));
    expect(
      redundantes,
      `Estas já rodam no test:hooks e não são mais exceção: ${redundantes.join(', ')}. ` +
        `Remova de scripts/hooks-suites-baseline.ts — baseline que não encolhe vira álibi.`,
    ).toEqual([]);
  });

  it('burn-down: entrada da baseline que sumiu do disco sai da baseline', () => {
    const podres = baseline.filter((f) => !noDisco.includes(f));
    expect(
      podres,
      `A baseline isenta suíte(s) que não existem mais: ${podres.join(', ')}. ` +
        `Remova de scripts/hooks-suites-baseline.ts.`,
    ).toEqual([]);
  });

  it('toda isenção da baseline tem motivo de verdade (não "TODO")', () => {
    const semMotivo = SUITES_FORA_DO_CI.filter((s) => s.motivo.trim().length < 40).map(
      (s) => s.arquivo,
    );
    expect(
      semMotivo,
      `Isenção sem motivo explicado: ${semMotivo.join(', ')}.`,
    ).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// EIXO 2: suítes `.ts`. Mesmo defeito de classe, outra extensão.
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// 2026-08-23: `scripts/test-migration-objects.ts` era ÓRFÃ desde o #922 — verde, 13 asserções,
// as ÚNICAS do repo sobre view/function/table/index/trigger/cron/enum do extrator, e ninguém a
// rodava. Não casava o `scripts/**/*.test.ts` do vitest (é `test-*.ts`, não `*.test.ts`) nem os
// laços do `test:hooks`. Ficou registrada como fora de escopo no #1902 e voltou aqui.
//
// ⚠️ O critério de "coberta" para `.ts` NÃO é o `test:hooks` — é o **glob do vitest**. E o gate
// lê o glob do `vitest.config.ts` DE VERDADE em vez de repetir a string: se alguém trocar o
// include, o gate acompanha em vez de mentir. É a lição 3 do doc da classe (prefira o
// conjunto-alvo ao identificador) aplicada ao outro eixo.
//
// Fora deste gate DE PROPÓSITO: as ~250 `db/test-*.sh`. Não são órfãs por descuido — são
// harnesses "PROVA PG17" que precisam de um PostgreSQL 17 vivo (ritual `prove-sql-money-path`,
// rodado à mão antes de entregar migration). Cobrá-las aqui geraria ~250 isenções de baseline
// no dia 1, e gate que nasce com 250 falsos-positivos ninguém lê.

/** Escapa metacaractere de regex — tudo que não for curinga do glob é literal. */
function escaparRegex(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Converte um glob do `vitest.config.ts` em RegExp. Suporta o que o config usa hoje:
 * `**` (atravessa diretórios), `*` (não atravessa `/`) e `{a,b}` (alternância).
 */
export function globParaRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      re += '(?:[^/]+/)*';
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '{') {
      const fim = glob.indexOf('}', i);
      if (fim < 0) {
        re += '\\{';
        continue;
      }
      re += `(?:${glob
        .slice(i + 1, fim)
        .split(',')
        .map((alt) => [...alt].map(escaparRegex).join(''))
        .join('|')})`;
      i = fim;
    } else {
      re += escaparRegex(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Os globs do `test.include` do vitest.config.ts, lidos da FONTE (não repetidos aqui). */
export function globsDoVitest(cfg: string): string[] {
  const bloco = /include\s*:\s*\[([^\]]*)\]/.exec(cfg);
  if (!bloco) return [];
  return [...bloco[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/**
 * Um `.ts` "tem cara de suíte" por NOME (convenção: `test-x.ts`, `x.test.ts`, `x.spec.ts`) ou
 * por CONTEÚDO (importa vitest). Os dois eixos, porque cada um pega o que o outro perde: a órfã
 * de 2026 não importava vitest (tinha `check()` próprio), e uma suíte futura pode importar
 * vitest com nome que não segue convenção nenhuma.
 */
const NOME_DE_SUITE = /(?:^|\/)(?:test-[^/]+|[^/]+[.-](?:test|spec))\.tsx?$/;

export function suitesTs(arquivos: { caminho: string; fonte: string }[]): string[] {
  return arquivos
    .filter((a) => NOME_DE_SUITE.test(a.caminho) || /\bfrom\s*["']vitest["']/.test(a.fonte))
    .map((a) => a.caminho)
    .sort();
}

/** Lista recursiva de `.ts` sob um diretório, com caminho relativo à raiz do repo. */
function listarTs(dir: string, prefixo: string): { caminho: string; fonte: string }[] {
  const out: { caminho: string; fonte: string }[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true })) {
    const rel = `${prefixo}${e.name}`;
    if (e.isDirectory()) out.push(...listarTs(`${dir}/${e.name}`, `${rel}/`));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx'))
      out.push({ caminho: rel, fonte: readFileSync(join(RAIZ, dir, e.name), 'utf8') });
  }
  return out;
}

describe('globParaRegex — parser', () => {
  it('`**/` atravessa diretórios, inclusive NENHUM', () => {
    const re = globParaRegex('scripts/**/*.test.ts');
    expect(re.test('scripts/lib/migration-objects.test.ts')).toBe(true);
    expect(re.test('scripts/hooks-guard-cobertura.test.ts')).toBe(true);
  });

  it('NÃO casa a órfã — é `test-x.ts`, não `x.test.ts` (o buraco de 2026-08-23)', () => {
    expect(globParaRegex('scripts/**/*.test.ts').test('scripts/test-migration-objects.ts')).toBe(false);
  });

  it('`*` sozinho não atravessa `/`', () => {
    expect(globParaRegex('scripts/*.test.ts').test('scripts/lib/x.test.ts')).toBe(false);
  });

  it('expande `{a,b}` (o config usa `{test,spec}.{ts,tsx}`)', () => {
    const re = globParaRegex('src/**/*.{test,spec}.{ts,tsx}');
    expect(re.test('src/a/b.spec.tsx')).toBe(true);
    expect(re.test('src/a/b.teste.ts')).toBe(false);
  });

  it('o `.` do glob é literal, não curinga', () => {
    expect(globParaRegex('scripts/*.test.ts').test('scripts/aXtest.ts')).toBe(false);
  });
});

describe('globsDoVitest — parser', () => {
  it('extrai os globs do include', () => {
    expect(globsDoVitest('test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] }')).toEqual([
      'src/**/*.test.ts',
      'scripts/**/*.test.ts',
    ]);
  });

  it('devolve vazio quando não há include (não finge cobertura)', () => {
    expect(globsDoVitest('test: { environment: "jsdom" }')).toEqual([]);
  });
});

describe('suitesTs — detector', () => {
  it('pega por NOME, nas três convenções', () => {
    expect(
      suitesTs([
        { caminho: 'scripts/test-x.ts', fonte: '' },
        { caminho: 'scripts/y.test.ts', fonte: '' },
        { caminho: 'scripts/z.spec.ts', fonte: '' },
        { caminho: 'scripts/gate-check.ts', fonte: 'export const x = 1;' },
      ]),
    ).toEqual(['scripts/test-x.ts', 'scripts/y.test.ts', 'scripts/z.spec.ts']);
  });

  it('pega por CONTEÚDO quando o nome não denuncia', () => {
    expect(suitesTs([{ caminho: 'scripts/verificacoes.ts', fonte: "import { it } from 'vitest';" }])).toEqual([
      'scripts/verificacoes.ts',
    ]);
  });

  it('não confunde CLI com suíte (o falso-positivo que mataria o gate)', () => {
    expect(suitesTs([{ caminho: 'scripts/testar-conexao.ts', fonte: '// roda à mão' }])).toEqual([]);
  });
});

describe('cobertura real: vitest.config.ts x scripts/ + db/', () => {
  const globs = globsDoVitest(readFileSync(join(RAIZ, 'vitest.config.ts'), 'utf8'));
  const arquivos = [...listarTs('scripts', 'scripts/'), ...listarTs('db', 'db/')];
  const suites = suitesTs(arquivos);
  const coberta = (caminho: string) => globs.some((g) => globParaRegex(g).test(caminho));

  it('o include do vitest não veio vazio (falsifica um regex que casou com nada)', () => {
    expect(globs.length).toBeGreaterThan(0);
  });

  it('o detector achou suítes de verdade (falsifica um detector que não casa nada)', () => {
    expect(suites.length).toBeGreaterThan(5);
  });

  it('nenhuma suíte `.ts` é ÓRFÃ — toda uma casa o glob do vitest', () => {
    const orfas = suites.filter((s) => !coberta(s));
    expect(
      orfas,
      `Suíte(s) .ts que o vitest NÃO roda: ${orfas.join(', ')}. ` +
        `Renomeie para \`<nome>.test.ts\` sob um diretório do \`include\` do vitest.config.ts ` +
        `(é o remédio barato — entra sozinha), ou acrescente o caminho ao \`include\`. ` +
        `Suíte que existe e não roda é AUSÊNCIA DE DADO, não aprovação.`,
    ).toEqual([]);
  });
});
