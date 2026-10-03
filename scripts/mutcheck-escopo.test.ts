import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GATILHOS_GLOBAIS,
  PARTES_TODOS,
  SEGUNDOS_POR_RODADA,
  contarPartes,
  decidir,
  estimarCusto,
  juntar,
  lerContrato,
  lerParte,
  lerResumos,
  linhasDeSaida,
  materializar,
  repartir,
  roda,
  selecionar,
  universo,
  type Contrato,
  type Resumo,
} from './mutcheck-escopo';

const A = lerContrato(
  'scripts/mutcheck.d/a.mut',
  ['# @src: src/lib/a.ts', '# @test: src/lib/a.test.ts', '', 'EXPECT PEGA', 's/x/y/'].join('\n'),
);
const B = lerContrato(
  'scripts/mutcheck.d/b.mut',
  ['# @src: .claude/hooks/b.sh', '# @test: scripts/test-b.sh', '# @test_cmd: bash', '# @compile_cmd: bash -n'].join('\n'),
);
/** Mesmo fonte de A, outro teste — o caso da sonda+canária. */
const C = lerContrato('scripts/mutcheck.d/c.mut', '# @src: src/lib/a.ts\n# @test: src/lib/a-consumidor.test.ts\n');
const CONTRATOS = [A, B, C];

describe('lerContrato — o escopo é o que o contrato MEDE', () => {
  it('lê @src e @test e ignora @test_cmd/@compile_cmd e o corpo', () => {
    expect(A.alvos).toEqual(['src/lib/a.ts', 'src/lib/a.test.ts']);
    expect(B.alvos).toEqual(['.claude/hooks/b.sh', 'scripts/test-b.sh']);
  });

  it('normaliza o `./` do começo, senão o caminho nunca casa o diff do git', () => {
    expect(lerContrato('x.mut', '# @src: ./src/x.ts\n# @test: ./src/x.test.ts').alvos).toEqual([
      'src/x.ts',
      'src/x.test.ts',
    ]);
  });

  it('contrato sem diretiva fica sem alvo (e o seletor trata isso como fail-closed)', () => {
    expect(lerContrato('x.mut', 's/a/b/\n').alvos).toEqual([]);
  });
});

describe('selecionar — só o contrato que o diff alcança', () => {
  it('diff só de docs não alcança contrato nenhum → nada a rodar', () => {
    const sel = selecionar(['docs/historico/x.md', 'README.md'], CONTRATOS);
    expect(sel).toMatchObject({ todos: false, contratos: [] });
    expect(roda(sel)).toBe(false);
  });

  it('mudou o @test de B → só B', () => {
    expect(selecionar(['scripts/test-b.sh'], CONTRATOS).contratos).toEqual(['scripts/mutcheck.d/b.mut']);
  });

  it('mudou o próprio .mut de B → só B', () => {
    expect(selecionar(['scripts/mutcheck.d/b.mut'], CONTRATOS).contratos).toEqual(['scripts/mutcheck.d/b.mut']);
  });

  it('mudou um fonte que DOIS contratos mutam → os dois', () => {
    const sel = selecionar(['src/lib/a.ts'], CONTRATOS);
    expect(sel.contratos).toEqual(['scripts/mutcheck.d/a.mut', 'scripts/mutcheck.d/c.mut']);
    expect(roda(sel)).toBe(true);
  });

  it('o motivo nomeia o arquivo que alcançou o contrato', () => {
    expect(selecionar(['src/lib/a.test.ts'], CONTRATOS).motivos).toEqual([
      'scripts/mutcheck.d/a.mut: alcançado por src/lib/a.test.ts',
    ]);
  });

  it.each(GATILHOS_GLOBAIS.map((g) => [g]))('gatilho global %s → TODOS', (g) => {
    const sel = selecionar(['docs/x.md', g], CONTRATOS);
    expect(sel.todos).toBe(true);
    expect(roda(sel)).toBe(true);
    expect(sel.motivos.join('\n')).toContain(g);
  });

  it('arquivo de apoio em scripts/mutcheck.d/ que não é .mut → TODOS', () => {
    expect(selecionar(['scripts/mutcheck.d/README.md'], CONTRATOS).todos).toBe(true);
  });

  it('contrato sem alvo declarado roda mesmo com diff alheio (fail-closed)', () => {
    const cego = lerContrato('scripts/mutcheck.d/cego.mut', 's/a/b/');
    const sel = selecionar(['docs/x.md'], [...CONTRATOS, cego]);
    expect(sel.contratos).toEqual(['scripts/mutcheck.d/cego.mut']);
    expect(roda(sel)).toBe(true);
  });

  it('caminho com `./` no diff casa igual', () => {
    expect(selecionar(['./scripts/test-b.sh'], CONTRATOS).contratos).toEqual(['scripts/mutcheck.d/b.mut']);
  });
});

describe('decidir — evento e leituras que falharam', () => {
  it.each(['push', 'workflow_dispatch'])('evento %s roda TODOS (a main é a rede)', (evento) => {
    expect(decidir(evento, ['docs/x.md'], CONTRATOS)).toMatchObject({ todos: true });
  });

  it('diff ilegível (null) → TODOS, nunca "pula"', () => {
    expect(decidir('pull_request', null, CONTRATOS)).toMatchObject({ todos: true });
  });

  it('contratos ilegíveis ou nenhum contrato → TODOS', () => {
    expect(decidir('pull_request', ['src/lib/a.ts'], null)).toMatchObject({ todos: true });
    expect(decidir('pull_request', ['src/lib/a.ts'], [])).toMatchObject({ todos: true });
  });

  it('PR com diff legível delega ao seletor', () => {
    expect(decidir('pull_request', ['docs/x.md'], CONTRATOS)).toMatchObject({ todos: false, contratos: [] });
  });
});

describe('saídas para o workflow', () => {
  it('linhasDeSaida escreve roda/todos/contratos', () => {
    expect(linhasDeSaida(selecionar(['src/lib/a.ts'], CONTRATOS))).toEqual([
      'roda=true',
      'todos=false',
      'contratos=scripts/mutcheck.d/a.mut scripts/mutcheck.d/c.mut',
      'partes=[1]',
    ]);
    expect(linhasDeSaida(selecionar(['docs/x.md'], CONTRATOS))[0]).toBe('roda=false');
    // matriz vazia não sobe nem para ficar SKIPPED: o vetor nunca é vazio
    expect(linhasDeSaida(selecionar(['docs/x.md'], CONTRATOS))[3]).toBe('partes=[1]');
    expect(linhasDeSaida(decidir('push', null, CONTRATOS))[3]).toBe(`partes=[${Array.from({ length: PARTES_TODOS }, (_, i) => i + 1).join(',')}]`);
  });

  it('materializar cria um symlink por contrato selecionado, apontando para o .mut', () => {
    const destino = join(mkdtempSync(join(tmpdir(), 'mutcheck-escopo-')), 'sel');
    const dir = materializar({ todos: false, contratos: ['scripts/mutcheck.d/a.mut'], motivos: [] }, destino);
    expect(dir).toBe(destino);
    expect(readdirSync(destino)).toEqual(['a.mut']);
    expect(readlinkSync(join(destino, 'a.mut'))).toBe(resolve('scripts/mutcheck.d/a.mut'));
  });

  it('materializar devolve null quando o certo é rodar TODOS ou não há seleção — o MUTCHECK_DIR fica sem definir', () => {
    const destino = join(mkdtempSync(join(tmpdir(), 'mutcheck-escopo-')), 'sel');
    // `todos` VENCE a lista: com ele ligado, apontar o MUTCHECK_DIR para um subconjunto mediria menos que todos.
    expect(materializar({ todos: true, contratos: ['scripts/mutcheck.d/a.mut'], motivos: [] }, destino)).toBeNull();
    expect(materializar({ todos: false, contratos: [], motivos: [] }, destino)).toBeNull();
    expect(existsSync(destino)).toBe(false);
  });
});

/** Contrato sintético com custo dado — o que importa para repartir é só o custo e o nome. */
const k = (nome: string, custo: number): Contrato => ({ mut: `scripts/mutcheck.d/${nome}.mut`, alvos: ['x'], custo });

describe('estimarCusto — (mutações + baseline) × custo de uma rodada do runner', () => {
  const muts = (n: number) => Array.from({ length: n }, (_, i) => `PEGA | m${i} | s/a${i}/b/`).join('\n');

  it('conta PEGA e SOBREVIVE (cada linha é uma rodada) e soma a do baseline', () => {
    const txt = `# @src: src/a.ts\n# @test: src/a.test.ts\n${muts(3)}\nSOBREVIVE | x | s/y/z/\n# PEGA | comentado não conta`;
    expect(estimarCusto(txt)).toBeCloseTo(5 * SEGUNDOS_POR_RODADA.vitestSrc);
  });

  it.each([
    ['# @test_cmd: bash', '# @test: scripts/test-x.sh', SEGUNDOS_POR_RODADA.bash],
    ['# @test_cmd: deno test --no-remote', '# @test: supabase/functions/_shared/x_test.ts', SEGUNDOS_POR_RODADA.deno],
    ['', '# @test: scripts/x-gate.test.ts', SEGUNDOS_POR_RODADA.vitestScripts],
    ['', '# @test: src/lib/x.test.ts', SEGUNDOS_POR_RODADA.vitestSrc],
  ])('peso do runner (%s %s)', (cmd, teste, peso) => {
    expect(estimarCusto(`# @src: x\n${teste}\n${cmd}\n${muts(9)}`)).toBeCloseTo(10 * peso);
  });

  it('lerContrato carrega o custo (o fixture A não tem linha PEGA|…: só o baseline)', () => {
    expect(A.custo).toBeCloseTo(SEGUNDOS_POR_RODADA.vitestSrc);
  });
});

describe('repartir — LPT determinístico', () => {
  const pool = [k('a', 10), k('b', 9), k('c', 8), k('d', 1), k('e', 1), k('f', 1)];

  it('cada contrato cai em EXATAMENTE uma parte', () => {
    const partes = repartir(pool, 3);
    const todos = partes.flat().map((c) => c.mut).sort();
    expect(todos).toEqual(pool.map((c) => c.mut).sort());
  });

  it('o mais caro primeiro, sempre na parte mais leve', () => {
    const somas = repartir(pool, 3).map((p) => p.reduce((s, c) => s + c.custo, 0));
    // 10|9|8, e cada 1 vai para a mais leve: 8→9, (empate 9×9 → menor índice) 9→10, 9→10
    expect(somas).toEqual([10, 10, 10]);
  });

  it('é determinístico e não depende da ordem de entrada (as partes e o agregador recalculam sozinhos)', () => {
    const a = repartir(pool, 3).map((p) => p.map((c) => c.mut));
    const b = repartir([...pool].reverse(), 3).map((p) => p.map((c) => c.mut));
    expect(b).toEqual(a);
  });

  it('empate de custo decide pelo nome', () => {
    expect(repartir([k('z', 5), k('y', 5)], 2).map((p) => p.map((c) => c.mut))).toEqual([
      ['scripts/mutcheck.d/y.mut'],
      ['scripts/mutcheck.d/z.mut'],
    ]);
  });

  it('n=1 põe tudo numa parte; n<1 vira 1', () => {
    expect(repartir(pool, 1)).toHaveLength(1);
    expect(repartir(pool, 0)[0]).toHaveLength(pool.length);
  });
});

describe('universo e materializar por parte', () => {
  const todos = decidir('push', null, CONTRATOS);

  it('universo: TODOS = todos os contratos; escopo = só os escolhidos', () => {
    expect(universo(todos, CONTRATOS)).toHaveLength(CONTRATOS.length);
    expect(universo(selecionar(['scripts/test-b.sh'], CONTRATOS), CONTRATOS).map((c) => c.mut)).toEqual(['scripts/mutcheck.d/b.mut']);
  });

  it('em TODOS, as N partes materializam fatias disjuntas que somam o universo', () => {
    const base = mkdtempSync(join(tmpdir(), 'mutcheck-partes-'));
    const vistos: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const dir = materializar(todos, join(base, `p${i}`), { i, n: 3 }, CONTRATOS);
      expect(dir).not.toBeNull();
      vistos.push(...readdirSync(dir!));
    }
    expect(vistos.sort()).toEqual(['a.mut', 'b.mut', 'c.mut']);
  });

  it('parte única mantém o comportamento de antes: TODOS ⇒ null (o default roda todos)', () => {
    expect(materializar(todos, join(mkdtempSync(join(tmpdir(), 'mc-')), 'x'), { i: 1, n: 1 }, CONTRATOS)).toBeNull();
  });

  it('sem contratos legíveis não há como repartir ⇒ null (a parte roda todos: caro, mas mede)', () => {
    expect(materializar(todos, join(mkdtempSync(join(tmpdir(), 'mc-')), 'x'), { i: 2, n: 3 }, [])).toBeNull();
  });

  it.each([
    [{ i: 0, n: 3 }],
    [{ i: 4, n: 3 }],
    [{ i: 1.5, n: 3 }],
  ])('parte inválida %j lança (o catch do CLI cai no lado seguro)', (parte) => {
    expect(() => materializar(todos, '/nao/usado', parte, CONTRATOS)).toThrow(/parte inválida/);
  });
});

describe('juntar — a UNIÃO das partes', () => {
  const p1 = [k('a', 10), k('d', 1)];
  const p2 = [k('b', 9)];
  const p3 = [k('c', 8)];
  const esperado = [p1, p2, p3];
  const linha = (nome: string, problema = false) => ({
    mut: `/runner/_temp/mutcheck-escopo/${nome}.mut`,
    exit: problema ? 1 : 0,
    invalidas: 0,
    divergencias: problema ? 1 : 0,
    abortou: false,
    sumario: '',
  });
  const resumo = (...nomes: string[]): Resumo => ({ total: nomes.length, com_problema: 0, contratos: nomes.map((n) => linha(n)) });

  it('união completa: soma, normaliza o caminho e NÃO é incompleta', () => {
    const j = juntar(esperado, new Map([[1, resumo('a', 'd')], [2, resumo('b')], [3, resumo('c')]]));
    expect(j.incompleto).toBe(false);
    expect(j.resumo.total).toBe(4);
    expect(j.resumo.contratos.map((c) => c.mut).sort()).toEqual([
      'scripts/mutcheck.d/a.mut',
      'scripts/mutcheck.d/b.mut',
      'scripts/mutcheck.d/c.mut',
      'scripts/mutcheck.d/d.mut',
    ]);
  });

  it('parte com fatia e SEM resumo ⇒ incompleto, e o motivo nomeia a parte', () => {
    const j = juntar(esperado, new Map([[1, resumo('a', 'd')], [3, resumo('c')]]));
    expect(j.incompleto).toBe(true);
    expect(j.resumo.partes_sem_resumo).toEqual([2]);
    expect(j.resumo.faltando).toEqual([]);
    expect(j.motivos.join('\n')).toContain('parte 2/3');
  });

  it('parte de fatia VAZIA sem resumo não acusa nada', () => {
    const j = juntar([p1, []], new Map([[1, resumo('a', 'd')]]));
    expect(j.incompleto).toBe(false);
  });

  it('contrato que a parte devia medir e não mediu ⇒ faltando', () => {
    const j = juntar(esperado, new Map([[1, resumo('a')], [2, resumo('b')], [3, resumo('c')]]));
    expect(j.incompleto).toBe(true);
    expect(j.resumo.faltando).toEqual(['d.mut']);
  });

  it('contrato medido duas vezes ⇒ duplicado (e fora da fatia de quem o mediu)', () => {
    const j = juntar(esperado, new Map([[1, resumo('a', 'd')], [2, resumo('b', 'a')], [3, resumo('c')]]));
    expect(j.incompleto).toBe(true);
    expect(j.resumo.duplicados).toEqual(['a.mut']);
    expect(j.resumo.inesperados).toEqual(['a.mut (parte 2)']);
  });

  it('nenhum resumo ⇒ incompleto (ausência de dado nunca fecha a Issue)', () => {
    expect(juntar(esperado, new Map()).incompleto).toBe(true);
  });
});

describe('leitura do CLI', () => {
  it('lerParte: "2/3" → {2,3}; ausente → parte única; malformado lança', () => {
    expect(lerParte('2/3')).toEqual({ i: 2, n: 3 });
    expect(lerParte(undefined)).toEqual({ i: 1, n: 1 });
    expect(() => lerParte('2-3')).toThrow(/malformado/);
  });

  it('contarPartes: o vetor da matriz; vazio ou ilegível lança', () => {
    expect(contarPartes('[1,2,3]')).toBe(3);
    expect(() => contarPartes('[]')).toThrow();
    expect(() => contarPartes(undefined)).toThrow();
  });

  it('lerResumos: lê parte-<k>.json e trata JSON ilegível como ausente', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mutcheck-resumos-'));
    writeFileSync(join(dir, 'parte-1.json'), JSON.stringify({ total: 1, com_problema: 0, contratos: [] }));
    writeFileSync(join(dir, 'parte-2.json'), '{quebrado');
    writeFileSync(join(dir, 'outro.json'), '{}');
    expect([...lerResumos(dir).keys()]).toEqual([1]);
    expect(lerResumos(join(dir, 'nao-existe')).size).toBe(0);
  });
});
