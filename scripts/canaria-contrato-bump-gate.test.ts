import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { RAIZ_EDGES } from './sonda-versao-bump-gate';
import {
  auditarContratos,
  contaComoFonteVisivel,
  exigirFonteDaBase,
  exigirListagem,
  FalhaAoMedir,
  indexarDefinicoes,
  localizarCanarias,
  superficieCanaria,
  type EstadoCanaria,
} from './canaria-contrato-bump-gate';

// Helper: monta um EstadoCanaria com o mínimo de ruído.
function estado(p: Partial<EstadoCanaria> & { edge: string }): EstadoCanaria {
  return {
    chave: 'case:probe',
    regua: 'superficie-da-canaria',
    contratoBase: 'marcador-v1',
    contratoHead: 'marcador-v1',
    corpo: [],
    ...p,
  };
}

function pseudo(base: string | null, head: string | null) {
  return [{ caminho: `${RAIZ_EDGES}/uma-edge/index.ts`, base, head }];
}

const limpa = (fonte: string) => removerComentarios(fonte);

describe('localizarCanarias — achar a emissão E o bloco que ela versiona', () => {
  it('acha o `case "<rota>"` que hospeda a emissão, não o objeto literal mais próximo', () => {
    const fonte = `
    switch (action) {
      case "doc_ambiguo_probe": {
        const fixtures = [{ caso: "a", expected: [] }];
        result = {
          canary: true,
          contrato: "doc-ambiguo-fail-closed-v1",
          ok: true,
        };
        break;
      }
    }`;
    const [c] = localizarCanarias(limpa(fonte));
    expect(c.chave).toBe('case:doc_ambiguo_probe');
    expect(c.contrato).toBe('doc-ambiguo-fail-closed-v1');
    // o bloco tem de conter a FIXTURE — é ela que viaja junto com o `expected`
    expect(c.bloco).toContain('const fixtures');
  });

  it('acha o arm `if (…)` quando a canária não é roteada por action', () => {
    const fonte = `
  if (new URL(req.url).searchParams.get('canary') === '1') {
    const expected = 123;
    return new Response(JSON.stringify({ canary: true, contrato: 'trava-saida-v1', expected }));
  }`;
    const [c] = localizarCanarias(limpa(fonte));
    expect(c.chave).toBe('if:1');
    expect(c.contrato).toBe('trava-saida-v1');
    expect(c.bloco).toContain('const expected = 123;');
  });

  it('descarta o `if` interno que FECHOU antes da emissão — senão o bloco perderia a fixture', () => {
    const fonte = `
      case "paginacao_probe": {
        const fixtures = [1, 2, 3];
        if (fixtures.length === 0) {
          throw new Error("vazio");
        }
        result = { canary: true, contrato: "paginacao-guards-v1" };
        break;
      }`;
    const [c] = localizarCanarias(limpa(fonte));
    expect(c.chave).toBe('case:paginacao_probe');
    expect(c.bloco).toContain('const fixtures');
  });

  it('duas canárias no mesmo arquivo viram DUAS chaves — o bump de uma não perdoa a outra', () => {
    const fonte = `
      case "a_probe": {
        result = { contrato: "a-v1" };
        break;
      }
      case "b_probe": {
        result = { contrato: "b-v1" };
        break;
      }`;
    expect(localizarCanarias(limpa(fonte)).map((c) => c.chave)).toEqual([
      'case:a_probe',
      'case:b_probe',
    ]);
  });

  it('fail-CLOSED: emissão sem arm delimitável devolve bloco null, e o núcleo REPROVA', () => {
    const [c] = localizarCanarias(limpa(`const result = { contrato: "orfao-v1" };`));
    expect(c.bloco).toBeNull();
    const achados = auditarContratos([
      estado({ edge: 'uma-edge', contratoHead: 'orfao-v1', indelimitavel: true }),
    ]);
    expect(achados).toHaveLength(1);
    expect(achados[0].motivo).toBe('bloco-indelimitavel');
  });

  it('CEGUEIRA: um `contrato` citado só em COMENTÁRIO não é emissão', () => {
    const fonte = `
      case "x_probe": {
        // o valor antigo era contrato: "velho-v1", trocado nesta fatia
        result = { contrato: "novo-v2" };
        break;
      }`;
    expect(localizarCanarias(limpa(fonte)).map((c) => c.contrato)).toEqual(['novo-v2']);
  });
});

describe('indexarDefinicoes — o índice que o fecho consulta', () => {
  it('indexa function, const e type de topo, com o CAMINHO no corpo', () => {
    const idx = indexarDefinicoes(
      new Map([
        [
          'a/x.ts',
          ['export function somar(a: number) {', '  return a + 1;', '}', 'const TETO = 10;', 'type T = 1;'].join('\n'),
        ],
      ]),
    );
    expect([...idx.keys()].sort()).toEqual(['TETO', 'T', 'somar'].sort());
    expect(idx.get('somar')).toContain('a/x.ts::somar');
    expect(idx.get('somar')).toContain('return a + 1;');
  });

  it('o corpo da definição vai até o fechamento — não para na primeira linha', () => {
    const idx = indexarDefinicoes(
      new Map([['a/x.ts', ['function f() {', '  const a = 1;', '  return a;', '}', 'function g() {}'].join('\n')]]),
    );
    expect(idx.get('f')).toContain('const a = 1;');
    expect(idx.get('f')).not.toContain('function g');
  });

  it('helper ANINHADO não entra — é o limite declarado no cabeçalho, e está aqui para não surpreender', () => {
    const idx = indexarDefinicoes(
      new Map([['a/x.ts', ['function fora() {', '  function dentro() {}', '  return dentro;', '}'].join('\n')]]),
    );
    expect(idx.has('fora')).toBe(true);
    expect(idx.has('dentro')).toBe(false);
  });
});

describe('superficieCanaria — o bloco MAIS o que ele exercita', () => {
  const defs = () =>
    indexarDefinicoes(
      new Map([
        [
          'a/x.ts',
          [
            'export function sobTeste(n: number) {',
            '  return auxiliar(n) * 2;',
            '}',
            'function auxiliar(n: number) {',
            '  return n + 1;',
            '}',
            'function naoAlcancada() {',
            '  return 42;',
            '}',
          ].join('\n'),
        ],
      ]),
    );

  it('puxa a função SOB TESTE para dentro da superfície', () => {
    expect(superficieCanaria('const r = sobTeste(1);', defs())).toContain('a/x.ts::sobTeste');
  });

  it('o fecho é TRANSITIVO — a função que a função sob teste chama entra junto', () => {
    expect(superficieCanaria('const r = sobTeste(1);', defs())).toContain('a/x.ts::auxiliar');
  });

  it('o que o bloco NÃO alcança fica fora — senão a régua viraria "o arquivo inteiro"', () => {
    expect(superficieCanaria('const r = sobTeste(1);', defs())).not.toContain('naoAlcancada');
  });

  it('mudar a função sob teste MUDA a superfície — é o que o gate mede', () => {
    const antes = superficieCanaria('const r = sobTeste(1);', defs());
    const mutado = indexarDefinicoes(
      new Map([
        ['a/x.ts', ['export function sobTeste(n: number) {', '  return auxiliar(n) * 3;', '}', 'function auxiliar(n: number) {', '  return n + 1;', '}'].join('\n')],
      ]),
    );
    expect(superficieCanaria('const r = sobTeste(1);', mutado)).not.toBe(antes);
  });
});

describe('auditarContratos — o julgamento', () => {
  it('superfície mudou e o `contrato` continua igual → REPROVA nomeando a canária', () => {
    const achados = auditarContratos([
      estado({ edge: 'uma-edge', chave: 'case:x_probe', corpo: pseudo('expected = 1', 'expected = 2') }),
    ]);
    expect(achados).toHaveLength(1);
    expect(achados[0]).toMatchObject({
      edge: 'uma-edge',
      chave: 'case:x_probe',
      motivo: 'sem-bump',
      contrato: 'marcador-v1',
    });
  });

  it('mesma mudança COM bump → passa', () => {
    expect(
      auditarContratos([
        estado({ edge: 'uma-edge', contratoHead: 'marcador-v2', corpo: pseudo('expected = 1', 'expected = 2') }),
      ]),
    ).toHaveLength(0);
  });

  it('superfície intocada → passa (é o caso da imensa maioria dos PRs)', () => {
    expect(
      auditarContratos([estado({ edge: 'uma-edge', corpo: pseudo('expected = 1', 'expected = 1') })]),
    ).toHaveLength(0);
  });

  it('canária que NASCE nesta fatia → passa: o marcador inicial já nomeia o que ela verifica', () => {
    expect(
      auditarContratos([
        estado({ edge: 'uma-edge', contratoBase: null, corpo: pseudo(null, 'expected = 1') }),
      ]),
    ).toHaveLength(0);
  });

  it('a régua viaja no achado — ela muda o que o autor precisa fazer', () => {
    const [a] = auditarContratos([
      estado({ edge: 'uma-edge', regua: 'corpo-servido', corpo: pseudo('a', 'b') }),
    ]);
    expect(a.regua).toBe('corpo-servido');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CALIBRAÇÃO contra as canárias REAIS — o que separa este gate de um que passa por cegueira.
//
// O fecho de símbolos é resolvido por TEXTO. Se o índice de definições parar de casar (renomeação
// de padrão, mudança de formatação, um `export const` virando outra coisa), a superfície encolhe
// para o bloco puro e o gate fica VERDE sem enxergar o código sob teste — indistinguível de verde
// por mérito. O único jeito de saber é SABOTAR a função sob teste e exigir que a superfície mude.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function fontesNoDisco(edge: string): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const dir of [`${RAIZ_EDGES}/${edge}`, `${RAIZ_EDGES}/_shared`]) {
    for (const nome of readdirSync(dir)) {
      const caminho = `${dir}/${nome}`;
      if (!statSync(caminho).isFile()) continue;
      if (!contaComoFonteVisivel(caminho, edge)) continue;
      fontes.set(caminho, removerComentarios(readFileSync(caminho, 'utf8')));
    }
  }
  return fontes;
}

function blocoReal(edge: string, chave: string): string {
  const fonte = removerComentarios(readFileSync(`${RAIZ_EDGES}/${edge}/index.ts`, 'utf8'));
  const c = localizarCanarias(fonte).find((x) => x.chave === chave);
  if (!c || c.bloco === null) throw new Error(`canária ${edge}[${chave}] não localizada/delimitada`);
  return c.bloco;
}

/** Insere uma linha REAL dentro do corpo da definição, sem tocar em mais nada. */
function sabotar(fontes: Map<string, string>, simbolo: string): Map<string, string> {
  const alvo = new RegExp(
    `^((?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|const|let|class)\\s+${simbolo}\\b.*)$`,
    'm',
  );
  const saida = new Map(fontes);
  for (const [caminho, fonte] of fontes) {
    if (!alvo.test(fonte)) continue;
    saida.set(caminho, fonte.replace(alvo, '$1\n  const SABOTAGEM_DA_CALIBRACAO = 1;'));
    return saida;
  }
  throw new Error(`sabotagem impossível: não achei a definição de \`${simbolo}\``);
}

// As funções que cada canária de fato EXERCITA. Não é lista de conveniência: é o que o `contrato`
// daquela canária promete sobre o bundle. Se uma canária deixar de exercitar a sua, o pin quebra —
// e quebrar é o desfecho certo, porque o marcador passou a nomear outra coisa.
const SOB_TESTE: Array<{ edge: string; chave: string; simbolo: string }> = [
  { edge: 'analyze-unified-order', chave: 'if:1', simbolo: 'mergeCustomerPrices' },
  { edge: 'carteira-rebuild', chave: 'if:1', simbolo: 'computeCarteira' },
  { edge: 'omie-analytics-sync', chave: 'case:doc_ambiguo_probe', simbolo: 'docsComCodigoAmbiguoNoOmie' },
  { edge: 'omie-analytics-sync', chave: 'case:transferencia_probe', simbolo: 'classificarLoteProof' },
  { edge: 'omie-financeiro', chave: 'case:paginacao_probe', simbolo: 'desfechoVarreduraReversa' },
  { edge: 'omie-vendas-sync', chave: 'case:identidade_probe', simbolo: 'decideAccountIdentity' },
];

// A fronteira de I/O é onde o gate irmão embarcou DOIS falsos-verdes com 23 testes de núcleo
// verdes (#2004): o status do `git diff` era descartado, e comando que falha devolve saída vazia,
// que o gate lia como "nada mudou". Aqui a fronteira é costurada e testada.
describe('fail-CLOSED na fronteira de I/O — vazio por FALHA não pode virar "nada mudou"', () => {
  it('`ls-tree` que FALHA lança, em vez de devolver lista vazia', () => {
    expect(() => exigirListagem('abc123', 'supabase/functions', { ok: false, saida: '' })).toThrow(
      FalhaAoMedir,
    );
  });

  it('`ls-tree` que SUCEDE vazio é resposta legítima — o diretório pode não existir naquela rev', () => {
    expect(exigirListagem('abc123', 'supabase/functions', { ok: true, saida: '' })).toEqual([]);
  });

  it('`ls-tree` que sucede devolve as linhas', () => {
    expect(exigirListagem('abc', 'd', { ok: true, saida: 'a/x.ts\nb/y.ts' })).toEqual([
      'a/x.ts',
      'b/y.ts',
    ]);
  });

  it('fonte ILEGÍVEL que o `ls-tree` da base LISTA lança — senão vira "a canária nasce" e PASSA', () => {
    expect(() => exigirFonteDaBase('a/index.ts', true, null)).toThrow(FalhaAoMedir);
  });

  it('fonte ausente que o `ls-tree` da base NÃO lista é a canária nascendo — legítimo', () => {
    expect(exigirFonteDaBase('a/index.ts', false, null)).toBeNull();
  });

  it('fonte legível passa intacta', () => {
    expect(exigirFonteDaBase('a/index.ts', true, 'const a = 1;')).toBe('const a = 1;');
  });
});

describe('CALIBRAÇÃO: a superfície das canárias REAIS enxerga o código sob teste', () => {
  it.each(SOB_TESTE)('$edge [$chave] resolve `$simbolo`', ({ edge, chave, simbolo }) => {
    const superficie = superficieCanaria(blocoReal(edge, chave), indexarDefinicoes(fontesNoDisco(edge)));
    expect(superficie, `o fecho não alcançou \`${simbolo}\` — o gate ficaria cego para ele`).toContain(
      `::${simbolo}`,
    );
  });

  it.each(SOB_TESTE)('SABOTAR `$simbolo` MUDA a superfície de $edge [$chave]', ({ edge, chave, simbolo }) => {
    const bloco = blocoReal(edge, chave);
    const fontes = fontesNoDisco(edge);
    const antes = superficieCanaria(bloco, indexarDefinicoes(fontes));
    const depois = superficieCanaria(bloco, indexarDefinicoes(sabotar(fontes, simbolo)));
    expect(depois, `sabotei \`${simbolo}\` e a superfície não mudou — o gate está cego`).not.toBe(antes);
  });

  it.each(SOB_TESTE)(
    'CONTROLE NEGATIVO: sabotar símbolo FORA do alcance não muda a superfície de $edge [$chave]',
    ({ edge, chave }) => {
      const bloco = blocoReal(edge, chave);
      const fontes = fontesNoDisco(edge);
      const defs = indexarDefinicoes(fontes);
      const antes = superficieCanaria(bloco, defs);
      const foraDoAlcance = [...defs.keys()].find((nome) => !antes.includes(`::${nome}\n`));
      expect(foraDoAlcance, 'toda definição do universo entrou na superfície — a régua virou "o arquivo inteiro"').toBeDefined();
      expect(superficieCanaria(bloco, indexarDefinicoes(sabotar(fontes, foraDoAlcance!)))).toBe(antes);
    },
  );
});

describe('SENTINELA: nenhuma emissão de `contrato` do repo escapa da medição', () => {
  it('toda emissão em supabase/functions tem bloco delimitável e chave única por arquivo', () => {
    const semBloco: string[] = [];
    const chavesRepetidas: string[] = [];
    for (const nome of readdirSync(RAIZ_EDGES)) {
      const index = `${RAIZ_EDGES}/${nome}/index.ts`;
      let fonte: string;
      try {
        fonte = readFileSync(index, 'utf8');
      } catch {
        continue;
      }
      const canarias = localizarCanarias(removerComentarios(fonte));
      for (const c of canarias) if (c.bloco === null) semBloco.push(`${nome}: ${c.contrato}`);
      const vistas = new Set<string>();
      for (const c of canarias) {
        if (vistas.has(c.chave)) chavesRepetidas.push(`${nome}: ${c.chave}`);
        vistas.add(c.chave);
      }
    }
    expect(semBloco, 'emissão de `contrato` sem bloco delimitável — o gate reprova, mas o lugar de descobrir isso é aqui').toEqual([]);
    expect(chavesRepetidas, 'duas canárias com a MESMA chave no mesmo arquivo: o pareamento base×HEAD ficaria ambíguo').toEqual([]);
  });
});
