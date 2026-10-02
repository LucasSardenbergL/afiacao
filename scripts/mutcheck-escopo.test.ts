import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  GATILHOS_GLOBAIS,
  decidir,
  lerContrato,
  linhasDeSaida,
  materializar,
  roda,
  selecionar,
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
    ]);
    expect(linhasDeSaida(selecionar(['docs/x.md'], CONTRATOS))[0]).toBe('roda=false');
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
