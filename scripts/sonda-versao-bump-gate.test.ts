import { describe, it, expect } from 'vitest';
import {
  auditarBump,
  contaComoCorpo,
  extrairVersao,
  normalizarFonte,
  type EstadoEdge,
} from './sonda-versao-bump-gate';

// Helper: monta um EstadoEdge com o mínimo de ruído.
function estado(p: Partial<EstadoEdge> & { edge: string }): EstadoEdge {
  return {
    versaoBase: 'v1.0-inicial',
    versaoHead: 'v1.0-inicial',
    corpo: [],
    ...p,
  };
}

describe('contaComoCorpo — o que é CORPO SERVIDO da edge', () => {
  it('conta o index.ts e os módulos que ele empacota', () => {
    expect(contaComoCorpo('supabase/functions/recommend/index.ts', 'recommend')).toBe(true);
    expect(contaComoCorpo('supabase/functions/recommend/prompt-sistema.ts', 'recommend')).toBe(true);
  });

  it('NÃO conta teste — o bundle é o mesmo com ele mudado', () => {
    expect(contaComoCorpo('supabase/functions/recommend/versao_test.ts', 'recommend')).toBe(false);
    expect(contaComoCorpo('supabase/functions/recommend/prompt.test.ts', 'recommend')).toBe(false);
  });

  it('NÃO conta o próprio versao.ts — ele é o marcador, não a fatia que o marcador nomeia', () => {
    expect(contaComoCorpo('supabase/functions/recommend/versao.ts', 'recommend')).toBe(false);
  });

  it('NÃO conta markdown nem arquivo de outra edge', () => {
    expect(contaComoCorpo('supabase/functions/recommend/README.md', 'recommend')).toBe(false);
    expect(contaComoCorpo('supabase/functions/omie-cliente/index.ts', 'recommend')).toBe(false);
  });

  it('fronteira é de SEGMENTO — `omie-sync` não engole `omie-sync-estoque`', () => {
    expect(contaComoCorpo('supabase/functions/omie-sync-estoque/index.ts', 'omie-sync')).toBe(false);
  });
});

describe('extrairVersao', () => {
  it('lê o literal do export', () => {
    expect(extrairVersao('export const VERSAO = "v1.1-corpo-tipado";')).toBe('v1.1-corpo-tipado');
    expect(extrairVersao("export const VERSAO = 'v2.0-x';")).toBe('v2.0-x');
  });

  it('devolve null quando não há marcador legível — o gate decide o que fazer', () => {
    expect(extrairVersao('export const OUTRA = "v1.0-x";')).toBeNull();
  });

  it('ignora um VERSAO que só existe DENTRO de comentário', () => {
    expect(extrairVersao('// export const VERSAO = "v9.9-fantasma";\nexport const VERSAO = "v1.0-real";'))
      .toBe('v1.0-real');
  });
});

describe('normalizarFonte — o que sobrevive à limpeza', () => {
  it('comentário de linha e de bloco somem', () => {
    expect(normalizarFonte('const a = 1; // nota\n/* bloco */\nconst b = 2;'))
      .toBe(normalizarFonte('const a = 1;\nconst b = 2;'));
  });

  it('indentação e linha em branco somem', () => {
    expect(normalizarFonte('  const a = 1;\n\n\n    const b = 2;'))
      .toBe(normalizarFonte('const a = 1;\nconst b = 2;'));
  });

  it('CEGUEIRA: um `/*` DENTRO de string não pode apagar o miolo do arquivo', () => {
    const fonte = 'const h = { Accept: "image/webp,*/*;q=0.8" };\nconst SEGREDO = 1;\n/* fim */';
    const limpo = normalizarFonte(fonte);
    expect(limpo).toContain('SEGREDO');
    expect(limpo).toContain('*/*;q=0.8');
    expect(limpo).not.toContain('fim');
  });

  it('mudança REAL de código sobrevive — senão o gate seria verde por cegueira', () => {
    expect(normalizarFonte('const a = 1;')).not.toBe(normalizarFonte('const a = 2;'));
  });
});

describe('auditarBump — o caso que motivou o gate', () => {
  it('#1938: index.ts mudou e o marcador ficou congelado → REPROVA nomeando a edge', () => {
    const achados = auditarBump([
      estado({
        edge: 'analyze-unified-order',
        versaoBase: 'v1.0-prompt-invertido-cacheado',
        versaoHead: 'v1.0-prompt-invertido-cacheado',
        corpo: [
          { caminho: 'supabase/functions/analyze-unified-order/index.ts', base: 'const a = 1;', head: 'const a = 2;' },
          { caminho: 'supabase/functions/analyze-unified-order/prompt-sistema_test.ts', base: 'x', head: 'y' },
        ],
      }),
    ]);
    expect(achados).toHaveLength(1);
    expect(achados[0].edge).toBe('analyze-unified-order');
    expect(achados[0].versao).toBe('v1.0-prompt-invertido-cacheado');
    expect(achados[0].arquivos).toEqual(['supabase/functions/analyze-unified-order/index.ts']);
  });

  it('mesma mudança COM bump → passa', () => {
    expect(
      auditarBump([
        estado({
          edge: 'analyze-unified-order',
          versaoBase: 'v1.0-prompt-invertido-cacheado',
          versaoHead: 'v1.1-corpo-tipado',
          corpo: [{ caminho: 'supabase/functions/analyze-unified-order/index.ts', base: 'const a = 1;', head: 'const a = 2;' }],
        }),
      ]),
    ).toEqual([]);
  });

  it('edge intocada → passa', () => {
    expect(auditarBump([estado({ edge: 'recommend' })])).toEqual([]);
  });
});

describe('auditarBump — o RUÍDO que mataria o gate', () => {
  it('só comentário mudou no index.ts → passa', () => {
    expect(
      auditarBump([
        estado({
          edge: 'recommend',
          corpo: [{ caminho: 'supabase/functions/recommend/index.ts', base: 'const a = 1; // antes', head: '// depois\nconst a = 1;' }],
        }),
      ]),
    ).toEqual([]);
  });

  it('só reindentação → passa', () => {
    expect(
      auditarBump([
        estado({
          edge: 'recommend',
          corpo: [{ caminho: 'supabase/functions/recommend/index.ts', base: 'const a = 1;', head: '    const a = 1;\n' }],
        }),
      ]),
    ).toEqual([]);
  });
});

describe('auditarBump — arquivo que nasce e arquivo que morre', () => {
  it('módulo NOVO no corpo conta como mudança', () => {
    const achados = auditarBump([
      estado({
        edge: 'recommend',
        corpo: [{ caminho: 'supabase/functions/recommend/novo.ts', base: null, head: 'export const x = 1;' }],
      }),
    ]);
    expect(achados).toHaveLength(1);
    expect(achados[0].arquivos).toEqual(['supabase/functions/recommend/novo.ts']);
  });

  it('módulo REMOVIDO do corpo conta como mudança', () => {
    expect(
      auditarBump([
        estado({
          edge: 'recommend',
          corpo: [{ caminho: 'supabase/functions/recommend/velho.ts', base: 'export const x = 1;', head: null }],
        }),
      ]),
    ).toHaveLength(1);
  });

  it('edge que NASCE instrumentada neste PR → passa (o marcador inicial já nomeia a fatia)', () => {
    expect(
      auditarBump([
        estado({
          edge: 'nova-edge',
          versaoBase: null,
          versaoHead: 'v1.0-sensor-inicial',
          corpo: [{ caminho: 'supabase/functions/nova-edge/index.ts', base: null, head: 'const a = 1;' }],
        }),
      ]),
    ).toEqual([]);
  });
});

describe('auditarBump — fail-CLOSED: sem marcador legível o gate REPROVA, não degrada', () => {
  it('VERSAO ilegível no HEAD com corpo alterado → reprova dizendo que não deu para ler', () => {
    const achados = auditarBump([
      estado({
        edge: 'recommend',
        versaoBase: 'v1.0-x',
        versaoHead: null,
        corpo: [{ caminho: 'supabase/functions/recommend/index.ts', base: 'const a = 1;', head: 'const a = 2;' }],
      }),
    ]);
    expect(achados).toHaveLength(1);
    expect(achados[0].motivo).toBe('marcador-ilegivel');
  });

  it('o achado do #1938 é do motivo `sem-bump`, não do fail-closed — motivos distintos', () => {
    const achados = auditarBump([
      estado({
        edge: 'recommend',
        corpo: [{ caminho: 'supabase/functions/recommend/index.ts', base: 'const a = 1;', head: 'const a = 2;' }],
      }),
    ]);
    expect(achados[0].motivo).toBe('sem-bump');
  });
});
