import { describe, it, expect } from 'vitest';
import { INERTES, citacoes, decidir, inerte, lerRepo, lidosEmInerte, resolverImport, type Repo } from './provas-sql-escopo';

const NENHUM: ReadonlySet<string> = new Set();

function repoFalso(arquivos: Record<string, string>): Repo {
  return {
    arquivos: Object.keys(arquivos),
    ler: (p) => (p in arquivos ? arquivos[p] : null),
    existe: (p) => p in arquivos,
  };
}

describe('provas-sql-escopo — decidir', () => {
  it('fora de pull_request roda TUDO, mesmo com diff só de docs', () => {
    for (const evento of ['push', 'workflow_dispatch', 'schedule', 'merge_group']) {
      expect(decidir(evento, ['docs/x.md'], NENHUM).roda, evento).toBe(true);
    }
  });

  it('diff ilegível, diff VAZIO ou mapa ilegível rodam (ausência de dado não é "nada mudou")', () => {
    expect(decidir('pull_request', null, NENHUM).roda).toBe(true);
    expect(decidir('pull_request', [], NENHUM).roda).toBe(true);
    expect(decidir('pull_request', ['docs/x.md'], null).roda).toBe(true);
  });

  it('PR só de docs/ pula', () => {
    expect(decidir('pull_request', ['docs/historico/a.md', 'docs/historico/README.md'], NENHUM).roda).toBe(false);
  });

  it('PR de src/ comum pula', () => {
    expect(decidir('pull_request', ['src/pages/Recebimento.tsx', 'src/lib/x.test.ts'], NENHUM).roda).toBe(false);
  });

  it('UM arquivo fora do inerte basta para rodar — e o motivo o nomeia', () => {
    const d = decidir('pull_request', ['docs/a.md', 'db/test-x.sh'], NENHUM);
    expect(d.roda).toBe(true);
    expect(d.motivos.join(' ')).toContain('db/test-x.sh');
  });

  it.each([
    'db/test-x.sh',
    'db/lib/qualquer.ts',
    'supabase/migrations/20261104000000_x.sql',
    'supabase/functions/_shared/x.ts',
    'supabase/schema-snapshot.sql',
    'supabase/config.toml',
    'scripts/db-aplicar.sh',
    'scripts/provas-sql-escopo.ts',
    'scripts/mutcheck-escopo.ts',
    '.github/workflows/ci.yml',
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'tsconfig.json',
    'README.md',
    'CLAUDE.md',
    'diretorio-que-ainda-nao-existe/x',
    'srcx/a.ts',
    'docsx.md',
  ])('%s RODA (não é inerte)', (f) => {
    expect(inerte(f, NENHUM)).toBe(false);
    expect(decidir('pull_request', [f], NENHUM).roda).toBe(true);
  });

  it('arquivo lido pelas provas dentro de um inerte RODA — igual, como diretório e sem extensão', () => {
    const lidos = new Set(['src/lib/financeiro/saldo-contas.ts', 'src/lib/gates', 'src/lib/apagado']);
    expect(inerte('src/lib/financeiro/saldo-contas.ts', lidos)).toBe(false);
    expect(inerte('src/lib/gates/passos.ts', lidos)).toBe(false);
    expect(inerte('src/lib/apagado.ts', lidos), 'import de arquivo que o PR apaga').toBe(false);
    expect(inerte('src/lib/gatesX.ts', lidos), 'prefixo de diretório exige a barra').toBe(true);
    expect(decidir('pull_request', ['docs/a.md', 'src/lib/gates/passos.ts'], lidos).roda).toBe(true);
  });

  it('caminho com ./ na frente é normalizado', () => {
    expect(inerte('./docs/a.md', NENHUM)).toBe(true);
  });
});

describe('provas-sql-escopo — o que as provas leem dentro do inerte', () => {
  it('citação literal em db/ conta — inclusive relativa e em comentário; o prefixo nu não', () => {
    expect(citacoes('grep X "$REPO_ROOT/src/lib/financeiro/saldo-contas.ts"')).toEqual(['src/lib/financeiro/saldo-contas.ts']);
    expect(citacoes("import x from '../../src/lib/a';")).toEqual(['src/lib/a']);
    expect(citacoes('# lê .claude/skills/cfo/a.sql.')).toEqual(['.claude/skills/cfo/a.sql']);
    expect(citacoes('-- nenhuma chamada em src/ nem em supabase/')).toEqual([]);
  });

  it('docs/ citado em comentário NÃO conta (é a concessão documentada no script)', () => {
    expect(citacoes('# detalhe em docs/agent/database.md')).toEqual([]);
  });

  it('resolve @/, relativo, .js→.ts, index.ts; pacote fica de fora', () => {
    const existe = (p: string) => ['src/lib/a.ts', 'scripts/lib/b.ts', 'src/lib/c/index.ts'].includes(p);
    expect(resolverImport('scripts/x.ts', '@/lib/a', existe)).toEqual({ base: 'src/lib/a', existentes: ['src/lib/a.ts'] });
    expect(resolverImport('db/lib/y.ts', '../../scripts/lib/b.js', existe)).toEqual({
      base: 'scripts/lib/b',
      existentes: ['scripts/lib/b.ts'],
    });
    expect(resolverImport('scripts/x.ts', '../src/lib/c', existe)).toEqual({
      base: 'src/lib/c',
      existentes: ['src/lib/c/index.ts'],
    });
    expect(resolverImport('scripts/x.ts', 'node:fs', existe)).toBeNull();
    expect(resolverImport('scripts/x.ts', 'vitest', existe)).toBeNull();
    expect(resolverImport('scripts/x.ts', '@/lib/sumiu', existe), 'não resolvido fica do lado seguro').toEqual({
      base: 'src/lib/sumiu',
      existentes: [],
    });
  });

  // Parecer Codex 2026-11-04: o Bun prefere `.tsx` a `.ts`. Um PR que acrescente `route-city.tsx` ao
  // lado do `.ts` muda o que o oráculo da prova carrega — e o escopo antigo, que escolhia o `.ts`,
  // dava roda=false.
  it('.ts e .tsx coexistindo: o PR que acrescenta o .tsx RODA (o lido é a base sem extensão)', () => {
    const arquivos = {
      'db/test-venda-gerador.sh': 'bun scripts/venda-cidades-alvo-esperado.ts',
      'scripts/venda-cidades-alvo-esperado.ts': "import { r } from '../src/lib/whatsapp/route-city';",
      'src/lib/whatsapp/route-city.ts': '',
    };
    const lidos = lidosEmInerte(repoFalso({ ...arquivos, 'src/lib/whatsapp/route-city.tsx': '' }));
    expect(decidir('pull_request', ['src/lib/whatsapp/route-city.tsx'], lidos).roda).toBe(true);
    // e o caso de antes do PR, com só o .ts: tocar QUALQUER variante roda
    const antes = lidosEmInerte(repoFalso(arquivos));
    for (const f of ['src/lib/whatsapp/route-city.ts', 'src/lib/whatsapp/route-city.tsx', 'src/lib/whatsapp/route-city.mts']) {
      expect(decidir('pull_request', [f], antes).roda, f).toBe(true);
    }
  });

  it('o fecho segue TODOS os candidatos existentes, não só o primeiro', () => {
    const lidos = lidosEmInerte(
      repoFalso({
        'db/lib/g.ts': "import { a } from '../../src/lib/dupla';",
        'src/lib/dupla.ts': "import { b } from './so-do-ts';",
        'src/lib/dupla.tsx': "import { c } from './so-do-tsx';",
        'src/lib/so-do-ts.ts': '',
        'src/lib/so-do-tsx.ts': '',
      }),
    );
    expect(inerte('src/lib/so-do-ts.ts', lidos)).toBe(false);
    expect(inerte('src/lib/so-do-tsx.ts', lidos)).toBe(false);
  });

  it('fecho transitivo: db/*.sh → scripts/*.ts citado → ../src → @/ → src', () => {
    const lidos = lidosEmInerte(
      repoFalso({
        'db/test-a.sh': 'bun scripts/esperado.ts "$X"',
        'db/lib/gera.ts': "import { f } from '../../scripts/lib/leitor';",
        'scripts/esperado.ts': "import { g } from '../src/lib/farmer/u';",
        'scripts/lib/leitor.ts': "import { h } from '@/lib/gates/limpeza';\nexport const k = await import('./dinamico');",
        'scripts/lib/dinamico.ts': "const r = require('../../src/lib/r');",
        'src/lib/farmer/u.ts': "import { v } from './v';",
        'src/lib/farmer/v.ts': '',
        'src/lib/gates/limpeza.ts': '',
        'src/lib/r.ts': '',
        'src/lib/solto.ts': "import { u } from './farmer/u';",
        'scripts/nao-citado.ts': "import '../src/lib/solto';",
      }),
    );
    for (const f of ['src/lib/farmer/u.ts', 'src/lib/farmer/v.ts', 'src/lib/gates/limpeza.ts', 'src/lib/r.ts']) {
      expect(inerte(f, lidos), f).toBe(false);
    }
    // `solto` só é alcançado por um script que nenhuma prova cita: segue inerte.
    expect(inerte('src/lib/solto.ts', lidos)).toBe(true);
  });

  it('INERTES não inclui nada que as provas sabidamente leem por inteiro', () => {
    for (const p of ['db/', 'supabase/', 'scripts/', '.github/']) expect(INERTES).not.toContain(p);
  });

  // Âncora do mapa de 2026-11-04 sobre a árvore REAL: o cálculo tem de achar o que o mapa achou à
  // mão. Se uma destas sair, a prova deixou de ler — ou o cálculo cegou; os dois pedem olho.
  it('na árvore real, o cálculo acha as leituras que o mapa de 2026-11-04 achou à mão', () => {
    const repo = lerRepo();
    expect(repo).not.toBeNull();
    const lidos = lidosEmInerte(repo!);
    for (const f of [
      'src/lib/financeiro/saldo-contas.ts',
      'src/lib/farmer/universo-pedidos.ts',
      'src/lib/whatsapp/route-city.ts',
      'src/lib/gates/limpeza-fonte.ts',
      'src/lib/erro-mensagem.ts',
      '.claude/skills/cfo-colacor/assets/sql/01-caixa-13-semanas.sql',
    ]) {
      expect(inerte(f, lidos), f).toBe(false);
    }
    expect(inerte('docs/historico/README.md', lidos)).toBe(true);
    expect(inerte('src/pages/Index.tsx', lidos)).toBe(true);
  });
});
