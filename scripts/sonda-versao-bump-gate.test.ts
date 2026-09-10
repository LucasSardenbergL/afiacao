import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { slugsDaAllowlist } from '../supabase/functions/_shared/sonda-cron-alvos';
import { fecharGrafo } from './sonda-fingerprint';
import {
  auditarBump,
  coletarEstado,
  contaComoCorpo,
  extrairVersao,
  FATIAS_EM_SHARED,
  main,
  montarEstado,
  normalizarFonte,
  projetarAlvosDoRele,
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

describe('montarEstado — desinstrumentar não pode ser a saída silenciosa do gate', () => {
  // leitor injetado: o `versao.ts` EXISTE na base e sumiu no HEAD; o corpo mudou junto.
  const ler = (rev: string | null, caminho: string): string | null => {
    if (caminho.endsWith('versao.ts')) return rev === 'BASE' ? 'export const VERSAO = "v1.0-a";' : null;
    return rev === 'BASE' ? 'const maxPages = 10;' : 'const maxPages = 500;';
  };

  it('marcador REMOVIDO no HEAD com corpo alterado → o gate reprova, não pula', () => {
    const estados = montarEstado(['supabase/functions/e/index.ts'], 'BASE', 'HEAD', ler);
    const achados = auditarBump(estados);
    expect(achados).toHaveLength(1);
    expect(achados[0].edge).toBe('e');
    expect(achados[0].motivo).toBe('marcador-ilegivel');
  });

  it('edge que NUNCA foi instrumentada continua fora do gate (sem marcador nos DOIS lados)', () => {
    const semMarcador = (rev: string | null, caminho: string): string | null =>
      caminho.endsWith('versao.ts') ? null : rev === 'BASE' ? 'const a = 1;' : 'const a = 2;';
    const estados = montarEstado(['supabase/functions/e/index.ts'], 'BASE', 'HEAD', semMarcador);
    expect(auditarBump(estados)).toEqual([]);
  });
});

describe('main — fail-CLOSED de verdade: lista vazia por ERRO não é lista vazia por mérito', () => {
  it('`git diff` que FALHA lança — lista vazia por erro não pode virar lista vazia por mérito', () => {
    expect(() => coletarEstado('inexistente-xyz-000', null)).toThrow(/falhou/);
  });

  it('--head que NÃO resolve reprova NOMEANDO o --head (e não por acidente de outro ramo)', () => {
    const erros: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void erros.push(a.join(' ')));
    try {
      expect(main(['--base', 'HEAD', '--head', 'inexistente-xyz-000'])).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(erros.join('\n')).toMatch(/--head/);
  });

  it('controle: o MESMO par com --head válido mede e passa', () => {
    expect(main(['--base', 'HEAD', '--head', 'HEAD'])).toBe(0);
  });
});

// ─── A fatia de UMA edge que mora em `_shared/`: a allowlist do cron é o comportamento do relé ───

const ALLOWLIST = 'supabase/functions/_shared/sonda-cron-alvos.ts';
const MARCADOR_RELE = 'supabase/functions/sonda-relay/versao.ts';

/** Fonte mínima com a FORMA da allowlist real: tipo, controle nomeado, entradas, função de slugs. */
function allowlist(slugs: string[], opcoes: { extra?: string; corpoControle?: string } = {}): string {
  return [
    'type AlvoSondaCron = { edge: string; desde: string | null; controles: readonly unknown[] };',
    `const CRON = { metodo: "POST", headers: {}, corpo: ${JSON.stringify(opcoes.corpoControle ?? '{}')}, nota: "x" };`,
    opcoes.extra ?? '',
    'export const SONDA_CRON_ALVOS: readonly AlvoSondaCron[] = [',
    ...slugs.map((s) => `  { edge: "${s}", desde: null, controles: [CRON] },`),
    '];',
    'export function slugsDaAllowlist() { return new Set(SONDA_CRON_ALVOS.map((a) => a.edge)); }',
  ].join('\n');
}

describe('projetarAlvosDoRele — o pedaço da allowlist que o relé LÊ em runtime', () => {
  it('é o conjunto de slugs, sem ordem', () => {
    expect(projetarAlvosDoRele(allowlist(['b', 'a']))).toBe(projetarAlvosDoRele(allowlist(['a', 'b'])));
    expect(projetarAlvosDoRele(allowlist(['a', 'b']))).not.toBe(projetarAlvosDoRele(allowlist(['a'])));
  });

  it('SUB-limpeza: candidata COMENTADA não é alvo (a allowlist real carrega candidatas em comentário)', () => {
    const comCandidatas = allowlist(['a'], {
      extra: '// { edge: "candidata-de-linha", desde: null, controles: [] },\n/* { edge: "candidata-de-bloco" } */',
    });
    expect(projetarAlvosDoRele(comCandidatas)).toBe(projetarAlvosDoRele(allowlist(['a'])));
  });

  it('mudar só `controles` NÃO muda a projeção — é dado da PROVA, não do relé', () => {
    expect(projetarAlvosDoRele(allowlist(['a'], { corpoControle: '{"action":"reprocess_all"}' })))
      .toBe(projetarAlvosDoRele(allowlist(['a'])));
  });

  it('CALIBRAÇÃO contra o runtime: no arquivo REAL, a projeção é exatamente `slugsDaAllowlist()`', () => {
    // O eixo POR FORA da regex: se alguém reestruturar a allowlist (constante no lugar do literal,
    // entrada montada por função), a projeção fica cega e este teste é quem denuncia — sem ele, a
    // fatia voltaria a passar sem bump com o gate verde.
    const esperado = [...slugsDaAllowlist()].sort();
    expect(esperado.length).toBeGreaterThan(1);
    expect(projetarAlvosDoRele(readFileSync(ALLOWLIST, 'utf8')).split('\n')).toEqual(esperado);
  });
});

describe('FATIAS_EM_SHARED — a declaração confere com o repo', () => {
  it('declara a allowlist do cron como fatia do relé', () => {
    expect(FATIAS_EM_SHARED.map((f) => [f.edge, f.arquivo])).toContainEqual(['sonda-relay', ALLOWLIST]);
  });

  it('PREMISSA: cada arquivo declarado está no FECHO da edge dona (a MESMA `fecharGrafo` do `fonte`)', () => {
    // Pega a declaração órfã: arquivo renomeado, typo no caminho, ou a edge que parou de importá-lo.
    // Órfã não reprova ninguém — o par simplesmente nunca mais casa e o gate volta a ser cego.
    for (const f of FATIAS_EM_SHARED) {
      expect(fecharGrafo(`supabase/functions/${f.edge}/index.ts`)).toContain(f.arquivo);
    }
  });

  it('PREMISSA da projeção: no fecho do relé, a allowlist só é lida por `slugsDaAllowlist`', () => {
    // A projeção compara SÓ o conjunto de slugs. Se o relé (ou um módulo do fecho dele) passar a
    // ler `SONDA_CRON_ALVOS` — `controles`, `desde` —, mudança nesses campos vira comportamento do
    // relé que a projeção não enxerga, e o gate fica verde por cegueira. Este teste é quem avisa
    // que a projeção precisa crescer junto.
    const importadores = fecharGrafo('supabase/functions/sonda-relay/index.ts')
      .filter((a) => a !== ALLOWLIST)
      .map((a) => ({ a, fonte: removerComentarios(readFileSync(a, 'utf8')) }))
      .filter(({ fonte }) => /sonda-cron-alvos\.ts["']/.test(fonte));
    expect(importadores.map((i) => i.a)).toEqual(['supabase/functions/sonda-relay/index.ts']);
    const nomes = importadores[0].fonte
      .match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*sonda-cron-alvos\.ts["']/)?.[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    expect(nomes).toEqual(['slugsDaAllowlist']);
  });
});

describe('auditarBump — a fatia declarada entra no corpo da edge DONA', () => {
  const rele = (base: string | null, head: string | null, versaoHead = 'v1.1-alvos-da-onda-1') =>
    estado({
      edge: 'sonda-relay',
      versaoBase: 'v1.1-alvos-da-onda-1',
      versaoHead,
      corpo: [{ caminho: ALLOWLIST, base, head }],
    });

  it('onda que ACRESCENTA alvo sem bumpar o relé → REPROVA nomeando o relé e a allowlist', () => {
    expect(auditarBump([rele(allowlist(['a']), allowlist(['a', 'b']))])).toEqual([
      { edge: 'sonda-relay', versao: 'v1.1-alvos-da-onda-1', motivo: 'sem-bump', arquivos: [ALLOWLIST] },
    ]);
  });

  it('a mesma onda COM bump do relé → passa', () => {
    expect(auditarBump([rele(allowlist(['a']), allowlist(['a', 'b']), 'v1.2-alvos-da-onda-2')])).toEqual([]);
  });

  it('alvo REMOVIDO também é comportamento do relé → reprova', () => {
    expect(auditarBump([rele(allowlist(['a', 'b']), allowlist(['a']))])).toHaveLength(1);
  });

  it('só `controles` mudou → passa: o `fonte` do relé muda (DIVERGE_P2 honesto), o comportamento não', () => {
    expect(auditarBump([rele(allowlist(['a']), allowlist(['a'], { corpoControle: '{"x":1}' }))])).toEqual([]);
  });

  it('a fatia é de UMA edge: a allowlist no corpo de OUTRA edge não conta', () => {
    expect(
      auditarBump([
        estado({ edge: 'recommend', corpo: [{ caminho: ALLOWLIST, base: allowlist(['a']), head: allowlist(['a', 'b']) }] }),
      ]),
    ).toEqual([]);
  });
});

describe('montarEstado — a allowlist tocada vira estado do RELÉ; o resto de `_shared/` continua fora', () => {
  const ler = (rev: string | null, caminho: string): string | null => {
    if (caminho === MARCADOR_RELE) return 'export const VERSAO = "v1.1-alvos-da-onda-1";';
    if (caminho === ALLOWLIST) return rev === 'BASE' ? allowlist(['a']) : allowlist(['a', 'b']);
    if (caminho === 'supabase/functions/_shared/auth.ts') return rev === 'BASE' ? 'const a = 1;' : 'const a = 2;';
    return null;
  };

  it('allowlist + helper comum tocados → só o relé vira estado, e reprova pela allowlist', () => {
    const estados = montarEstado([ALLOWLIST, 'supabase/functions/_shared/auth.ts'], 'BASE', 'HEAD', ler);
    expect(estados.map((e) => e.edge)).toEqual(['sonda-relay']);
    expect(auditarBump(estados)).toEqual([
      { edge: 'sonda-relay', versao: 'v1.1-alvos-da-onda-1', motivo: 'sem-bump', arquivos: [ALLOWLIST] },
    ]);
  });

  it('controle: helper comum de `_shared/` sozinho continua FORA do gate (a exclusão medida fica de pé)', () => {
    expect(montarEstado(['supabase/functions/_shared/auth.ts'], 'BASE', 'HEAD', ler)).toEqual([]);
  });
});

describe('a história REAL — as ondas 2 a 5 passaram com o marcador do relé congelado', () => {
  // Commits squash da `main`, imutáveis. O job `testes` do CI tem `fetch-depth: 0`; história rasa
  // faz o `coletarEstado` LANÇAR (vermelho) — nunca devolver lista vazia (verde por acidente). E o
  // assert casa a LISTA INTEIRA: prova também que nenhuma outra edge dessas fatias passa a reprovar.
  const congelado = { edge: 'sonda-relay', versao: 'v1.1-alvos-da-onda-1', motivo: 'sem-bump', arquivos: [ALLOWLIST] };

  it.each([
    ['89887025b', 'onda 2 (#2388)'],
    ['d96b69f06', 'onda 3 (#2404)'],
    ['a73641e9c', 'onda 4 (#2415)'],
    ['f4578bbff', 'onda 5 (#2461)'],
  ])('%s — %s: reprova o relé, e só ele', (sha) => {
    expect(auditarBump(coletarEstado(`${sha}^`, sha))).toEqual([congelado]);
  });

  it('controle: a onda 1 (54679dc35, #2313) BUMPOU o relé → nenhum achado', () => {
    expect(auditarBump(coletarEstado('54679dc35^', '54679dc35'))).toEqual([]);
  });
});
