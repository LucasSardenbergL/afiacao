import { describe, expect, it } from 'vitest';
import {
  extrairDeclaracao,
  formatarVeredito,
  julgar,
  lerValor,
  medirPopulacao,
  type EntradaJulgamento,
} from './ordem-entre-edges-declaracao';

// As marcas entre colchetes nos títulos são o que `scripts/falsificar-ordem-entre-edges-declaracao.sh`
// exige no vermelho de cada sabotagem: ASCII, caixa fixa, e só aparecem quando o teste FALHA.

describe('lerValor — o que vem depois de "Ordem entre edges:"', () => {
  it('[DECL_NENHUMA] aceita nenhuma', () => {
    expect(lerValor('nenhuma')).toEqual({ ok: true, declaracao: { tipo: 'nenhuma' } });
    expect(lerValor('  nenhuma  ')).toEqual({ ok: true, declaracao: { tipo: 'nenhuma' } });
  });

  // Caixa fixa de propósito: a declaração é para a máquina, e "Nenhuma"/"NENHUMA" aceitos abririam
  // a porta para a variação que o gate não enumera.
  it('[DECL_CAIXA_FIXA] recusa nenhuma com outra caixa', () => {
    expect(lerValor('Nenhuma').ok).toBe(false);
  });

  it('[DECL_VALOR_VAZIO] recusa valor vazio', () => {
    expect(lerValor('').ok).toBe(false);
    expect(lerValor('   ').ok).toBe(false);
  });

  it('[DECL_SETAS] lê um par com a seta unicode e com a seta ASCII', () => {
    const par = [{ antes: 'sync-reprocess', depois: 'omie-vendas-sync' }];
    expect(lerValor('sync-reprocess → omie-vendas-sync')).toEqual({ ok: true, declaracao: { tipo: 'pares', pares: par } });
    expect(lerValor('sync-reprocess -> omie-vendas-sync')).toEqual({ ok: true, declaracao: { tipo: 'pares', pares: par } });
  });

  it('[DECL_CRASES_NO_NOME] aceita o nome da edge entre crases', () => {
    expect(lerValor('`sync-reprocess` → `omie-vendas-sync`')).toEqual({
      ok: true,
      declaracao: { tipo: 'pares', pares: [{ antes: 'sync-reprocess', depois: 'omie-vendas-sync' }] },
    });
  });

  it('[DECL_CADEIA] desdobra a cadeia em pares consecutivos', () => {
    expect(lerValor('a → b → c')).toEqual({
      ok: true,
      declaracao: { tipo: 'pares', pares: [{ antes: 'a', depois: 'b' }, { antes: 'b', depois: 'c' }] },
    });
  });

  it('[DECL_SEPARADORES] separa pares por ponto e vírgula e por vírgula', () => {
    const pares = [{ antes: 'a', depois: 'b' }, { antes: 'c', depois: 'd' }];
    expect(lerValor('a → b; c → d')).toEqual({ ok: true, declaracao: { tipo: 'pares', pares } });
    expect(lerValor('a → b, c → d')).toEqual({ ok: true, declaracao: { tipo: 'pares', pares } });
  });

  it('[DECL_PAR_REPETIDO] junta par repetido', () => {
    expect(lerValor('a → b; a → b')).toEqual({ ok: true, declaracao: { tipo: 'pares', pares: [{ antes: 'a', depois: 'b' }] } });
  });

  it('[DECL_EDGE_ANTES_DELA_MESMA] recusa a edge antes dela mesma', () => {
    expect(lerValor('a → a').ok).toBe(false);
  });

  it('[DECL_PAR_INCOMPLETO] recusa par sem uma das pontas', () => {
    expect(lerValor('a →').ok).toBe(false);
    expect(lerValor('→ b').ok).toBe(false);
    expect(lerValor('a').ok).toBe(false);
    expect(lerValor('a → b;').ok).toBe(false);
  });

  it('[DECL_SLUG] recusa nome fora do formato de slug', () => {
    expect(lerValor('Sync-Reprocess → omie-vendas-sync').ok).toBe(false);
    expect(lerValor('sync_reprocess → omie-vendas-sync').ok).toBe(false);
  });

  it('[DECL_NENHUMA_COM_PARES] recusa nenhuma misturada com pares', () => {
    expect(lerValor('nenhuma; a → b').ok).toBe(false);
  });

  it('[DECL_PONTUACAO_FINAL] recusa pontuação no fim', () => {
    expect(lerValor('nenhuma.').ok).toBe(false);
  });
});

describe('extrairDeclaracao — a linha no corpo do PR', () => {
  it('[DECL_LINHA_BASE_1] acha a linha e devolve o número dela (base 1)', () => {
    expect(extrairDeclaracao('## Deploy\n\nOrdem entre edges: nenhuma\n')).toEqual({
      estado: 'valida',
      linha: 3,
      declaracao: { tipo: 'nenhuma' },
    });
  });

  // O GitHub guarda o corpo editado pela web com \r\n: o \r no fim da linha não pode virar parte do valor.
  it('[DECL_CRLF] lê corpo com CRLF', () => {
    expect(extrairDeclaracao('texto\r\nOrdem entre edges: nenhuma\r\nfim')).toEqual({
      estado: 'valida',
      linha: 2,
      declaracao: { tipo: 'nenhuma' },
    });
  });

  it('[DECL_AUSENTE] corpo sem a linha é ausente', () => {
    expect(extrairDeclaracao('## Deploy\n\n2 edges, nesta ordem: a → b')).toEqual({
      estado: 'ausente',
      quaseAcertos: [],
      cercaAbertaNaLinha: null,
    });
  });

  it('[DECL_CORPO_VAZIO] corpo vazio é ausente', () => {
    expect(extrairDeclaracao('')).toMatchObject({ estado: 'ausente' });
  });

  // Exemplo dentro de cerca é exibição, não afirmação — o próprio PR que documenta a gramática
  // precisa poder citá-la sem se declarar.
  it('[DECL_CERCA_IGNORADA] ignora a linha dentro de bloco cercado', () => {
    expect(extrairDeclaracao('```\nOrdem entre edges: nenhuma\n```')).toEqual({
      estado: 'ausente',
      quaseAcertos: [],
      cercaAbertaNaLinha: null,
    });
  });

  it('[DECL_CERCA_ABERTA] cerca que nunca fecha esconde a declaração e o veredito diz onde ela abriu', () => {
    expect(extrairDeclaracao('a\n```\nsem fechar\nOrdem entre edges: nenhuma')).toEqual({
      estado: 'ausente',
      quaseAcertos: [],
      cercaAbertaNaLinha: 2,
    });
  });

  it('[DECL_QUASE_ACERTO_DECORACAO] marcador de lista, negrito, crase, título e indentação não declaram, mas viram quase-acerto', () => {
    for (const linha of [
      '- Ordem entre edges: nenhuma',
      '**Ordem entre edges:** nenhuma',
      '`Ordem entre edges: nenhuma`',
      '  Ordem entre edges: nenhuma',
      '> Ordem entre edges: nenhuma',
      '## Ordem entre edges: nenhuma',
    ]) {
      expect(extrairDeclaracao(`x\n${linha}`)).toEqual({
        estado: 'ausente',
        quaseAcertos: [{ linha: 2, texto: linha.trim() }],
        cercaAbertaNaLinha: null,
      });
    }
  });

  it('[DECL_QUASE_ACERTO_CAIXA] outra caixa vira quase-acerto', () => {
    expect(extrairDeclaracao('ordem entre edges: nenhuma')).toEqual({
      estado: 'ausente',
      quaseAcertos: [{ linha: 1, texto: 'ordem entre edges: nenhuma' }],
      cercaAbertaNaLinha: null,
    });
  });

  it('[DECL_PROSA_NAO_E_QUASE] prosa que só menciona ordem entre edges não é quase-acerto', () => {
    expect(extrairDeclaracao('A ordem entre edges importa aqui.')).toEqual({
      estado: 'ausente',
      quaseAcertos: [],
      cercaAbertaNaLinha: null,
    });
  });

  it('[DECL_QUASE_NAO_ATRAPALHA] quase-acerto não atrapalha quando a declaração existe', () => {
    expect(extrairDeclaracao('Use `Ordem entre edges: nenhuma`\nOrdem entre edges: nenhuma')).toEqual({
      estado: 'valida',
      linha: 2,
      declaracao: { tipo: 'nenhuma' },
    });
  });

  // Duas linhas, mesmo iguais, são ambíguas: qual delas o autor atualizou por último?
  it('[DECL_DUPLICADA] duas linhas de declaração é duplicada', () => {
    expect(extrairDeclaracao('Ordem entre edges: nenhuma\n\nOrdem entre edges: nenhuma')).toEqual({
      estado: 'duplicada',
      linhas: [1, 3],
    });
    expect(extrairDeclaracao('Ordem entre edges: a → b\nOrdem entre edges: Nenhuma')).toMatchObject({
      estado: 'duplicada',
      linhas: [1, 2],
    });
  });

  it('[DECL_INVALIDA] valor ilegível é inválida, com a linha', () => {
    expect(extrairDeclaracao('x\nOrdem entre edges: Nenhuma')).toMatchObject({ estado: 'invalida', linha: 2 });
  });
});

const corpoDe = (edge: string) => `supabase/functions/${edge}/index.ts`;
const manifestoDe = (edge: string) => `supabase/functions/${edge}/deploy-ordem.json`;

describe('medirPopulacao — quem precisa declarar', () => {
  const noHead = new Set(['a', 'b', 'sonda-relay']);

  it('[POP_DUAS_EDGES] corpo de duas edges exige a declaração', () => {
    expect(medirPopulacao([corpoDe('b'), 'supabase/functions/a/lib/util.ts'], noHead)).toEqual({
      edgesComCorpo: ['a', 'b'],
      manifestosTocados: [],
      exigida: true,
    });
  });

  it('[POP_UMA_EDGE] corpo de uma edge só não exige', () => {
    expect(medirPopulacao([corpoDe('a'), 'supabase/functions/a/lib/util.ts'], noHead)).toMatchObject({ exigida: false });
  });

  // `contaComoCorpo`, o mesmo predicado do `sonda:bump`: teste e marcador não viram bundle servido.
  it('[POP_TESTE_NAO_E_CORPO] teste e versao.ts de outra edge não contam', () => {
    expect(
      medirPopulacao([corpoDe('a'), 'supabase/functions/b/index_test.ts', 'supabase/functions/b/versao.ts'], noHead),
    ).toEqual({ edgesComCorpo: ['a'], manifestosTocados: [], exigida: false });
  });

  it('[POP_ARQUIVO_NAO_CORPO] .md e .json na pasta da edge não contam', () => {
    expect(medirPopulacao([corpoDe('a'), 'supabase/functions/b/README.md', 'supabase/functions/b/deno.json'], noHead)).toMatchObject({
      edgesComCorpo: ['a'],
      exigida: false,
    });
  });

  // Medido em 400 PRs: contar o fan-out de `_shared/` triplicaria a população (16 → 51) com a mesma
  // uma declaração real. O resíduo — ordem que nasce só por `_shared/` — está no histórico.
  it('[POP_SHARED_FORA] _shared/ não conta como corpo de edge', () => {
    expect(medirPopulacao([corpoDe('a'), 'supabase/functions/_shared/omie-pedido.ts'], noHead)).toMatchObject({
      edgesComCorpo: ['a'],
      exigida: false,
    });
  });

  // A exceção que o `sonda:bump` já declara: esse arquivo de `_shared/` É a fatia de uma edge.
  it('[POP_FATIA_EM_SHARED] a fatia declarada em _shared/ conta para a edge dona', () => {
    expect(medirPopulacao([corpoDe('a'), 'supabase/functions/_shared/sonda-cron-alvos.ts'], noHead)).toEqual({
      edgesComCorpo: ['a', 'sonda-relay'],
      manifestosTocados: [],
      exigida: true,
    });
  });

  it('[POP_SO_EDGE_DO_HEAD] pasta sem index.ts no HEAD não é edge', () => {
    expect(medirPopulacao([corpoDe('a'), corpoDe('apagada')], noHead)).toMatchObject({ edgesComCorpo: ['a'], exigida: false });
  });

  it('[POP_MANIFESTO_TOCADO] manifesto tocado exige a declaração mesmo sem corpo', () => {
    expect(medirPopulacao([manifestoDe('b')], noHead)).toEqual({ edgesComCorpo: [], manifestosTocados: ['b'], exigida: true });
  });
});

describe('julgar — a declaração contra o artefato', () => {
  const pares = (o: Record<string, string[]>) => new Map(Object.entries(o).map(([b, as]) => [b, new Set(as)]));
  const entrada = (p: Partial<EntradaJulgamento>): EntradaJulgamento => ({
    corpo: '',
    tocados: [],
    edgesNoHead: new Set(['a', 'b', 'c', 'd']),
    paresNoHead: new Map(),
    paresNaBase: new Map(),
    ilegiveisNoHead: new Map(),
    ilegiveisNaBase: new Map(),
    ...p,
  });
  const duasEdges = [corpoDe('a'), corpoDe('b')];
  const marcas = (v: ReturnType<typeof julgar>) => (v.aprovado ? [v.marca] : v.achados.map((x) => x.marca));

  it('[JULG_NAO_EXIGIDA] fora da população e sem declaração aprova', () => {
    expect(marcas(julgar(entrada({ tocados: [corpoDe('a')] })))).toEqual(['ORDEM_NAO_EXIGIDA']);
  });

  it('[JULG_AUSENTE_REPROVA] na população e sem declaração reprova citando as edges e as duas formas', () => {
    const v = julgar(entrada({ tocados: duasEdges, corpo: '## Deploy\n\nnesta ordem: a → b' }));
    expect(marcas(v)).toEqual(['ORDEM_DECLARACAO_AUSENTE']);
    const msg = v.aprovado ? '' : v.achados[0].mensagem;
    // Entre crases: a letra solta casaria "nenhuma" e a asserção passaria sem a lista de edges.
    expect(msg).toContain('`a`');
    expect(msg).toContain('`b`');
    expect(msg).toContain('Ordem entre edges: nenhuma');
    expect(msg).toContain('Ordem entre edges: A → B');
  });

  it('[JULG_DICA_QUASE_ACERTO] a mensagem de ausente aponta o quase-acerto', () => {
    const v = julgar(entrada({ tocados: duasEdges, corpo: '- Ordem entre edges: nenhuma' }));
    expect(v.aprovado ? '' : v.achados[0].mensagem).toContain('- Ordem entre edges: nenhuma');
  });

  it('[JULG_NENHUMA_APROVA] nenhuma aprova a população', () => {
    expect(marcas(julgar(entrada({ tocados: duasEdges, corpo: 'Ordem entre edges: nenhuma' })))).toEqual(['ORDEM_DECLARADA_NENHUMA']);
  });

  it('[JULG_DUPLICADA_REPROVA] duplicada reprova mesmo fora da população', () => {
    expect(marcas(julgar(entrada({ corpo: 'Ordem entre edges: nenhuma\nOrdem entre edges: nenhuma' })))).toEqual([
      'ORDEM_DECLARACAO_DUPLICADA',
    ]);
  });

  it('[JULG_INVALIDA_REPROVA] inválida reprova mesmo fora da população', () => {
    expect(marcas(julgar(entrada({ corpo: 'Ordem entre edges: talvez' })))).toEqual(['ORDEM_DECLARACAO_INVALIDA']);
  });

  it('[JULG_PAR_COM_MANIFESTO_APROVA] par com o manifesto de B contendo A aprova', () => {
    const v = julgar(entrada({ tocados: [...duasEdges, manifestoDe('b')], corpo: 'Ordem entre edges: a → b', paresNoHead: pares({ b: ['a'] }) }));
    expect(marcas(v)).toEqual(['ORDEM_DECLARADA_PARES']);
  });

  it('[JULG_MANIFESTO_AUSENTE] par sem manifesto de B reprova', () => {
    expect(marcas(julgar(entrada({ tocados: duasEdges, corpo: 'Ordem entre edges: a → b' })))).toEqual(['ORDEM_MANIFESTO_AUSENTE']);
  });

  it('[JULG_MANIFESTO_SEM_PAR] manifesto de B sem A reprova', () => {
    const v = julgar(entrada({ tocados: duasEdges, corpo: 'Ordem entre edges: a → b', paresNoHead: pares({ b: ['c'] }) }));
    expect(marcas(v)).toEqual(['ORDEM_MANIFESTO_SEM_PAR']);
  });

  it('[JULG_MANIFESTO_ILEGIVEL_DECLARADO] par cujo manifesto de B é ilegível reprova', () => {
    const v = julgar(entrada({ tocados: duasEdges, corpo: 'Ordem entre edges: a → b', ilegiveisNoHead: new Map([['b', 'não é JSON']]) }));
    expect(marcas(v)).toEqual(['ORDEM_MANIFESTO_ILEGIVEL']);
  });

  it('[JULG_EDGE_INEXISTENTE] edge que não existe no HEAD reprova', () => {
    const v = julgar(entrada({ tocados: duasEdges, corpo: 'Ordem entre edges: x → b', paresNoHead: pares({ b: ['x'] }) }));
    expect(marcas(v)).toEqual(['ORDEM_EDGE_INEXISTENTE']);
  });

  it('[JULG_PAR_NOVO_NAO_DECLARADO] manifesto que ganha par na fatia, com nenhuma, reprova', () => {
    const v = julgar(entrada({ tocados: [...duasEdges, manifestoDe('b')], corpo: 'Ordem entre edges: nenhuma', paresNoHead: pares({ b: ['a'] }) }));
    expect(marcas(v)).toEqual(['ORDEM_PAR_NAO_DECLARADO']);
  });

  it('[JULG_PAR_ANTIGO_NAO_EXIGE] par que já estava na base não precisa ser declarado de novo', () => {
    const v = julgar(
      entrada({
        tocados: [...duasEdges, manifestoDe('b')],
        corpo: 'Ordem entre edges: nenhuma',
        paresNoHead: pares({ b: ['a', 'c'] }),
        paresNaBase: pares({ b: ['a', 'c'] }),
      }),
    );
    expect(marcas(v)).toEqual(['ORDEM_DECLARADA_NENHUMA']);
  });

  it('[JULG_REAFIRMAR_SEM_CHURN] reafirmar par que o HEAD já tem, sem tocar o manifesto, aprova', () => {
    const v = julgar(entrada({ tocados: duasEdges, corpo: 'Ordem entre edges: a → b', paresNoHead: pares({ b: ['a'] }), paresNaBase: pares({ b: ['a'] }) }));
    expect(marcas(v)).toEqual(['ORDEM_DECLARADA_PARES']);
  });

  it('[JULG_MANIFESTO_TOCADO_ILEGIVEL] manifesto tocado e ilegível reprova mesmo com nenhuma', () => {
    const v = julgar(entrada({ tocados: [manifestoDe('b')], corpo: 'Ordem entre edges: nenhuma', ilegiveisNoHead: new Map([['b', 'chave extra']]) }));
    expect(marcas(v)).toEqual(['ORDEM_MANIFESTO_ILEGIVEL']);
  });

  // Base ilegível não é "sem pares": sem saber o que havia antes, TODO par do HEAD conta como novo —
  // a leitura mais exigente, nunca a que aprova por falta de dado.
  it('[JULG_BASE_ILEGIVEL_TUDO_NOVO] base ilegível faz todo par do HEAD contar como novo', () => {
    const v = julgar(
      entrada({
        tocados: [manifestoDe('b')],
        corpo: 'Ordem entre edges: nenhuma',
        paresNoHead: pares({ b: ['a'] }),
        paresNaBase: pares({ b: ['a'] }),
        ilegiveisNaBase: new Map([['b', 'não é JSON']]),
      }),
    );
    expect(marcas(v)).toEqual(['ORDEM_PAR_NAO_DECLARADO']);
    expect(v.notas.join('\n')).toContain('b');
  });

  it('[JULG_RETIRADA_COM_NENHUMA] manifesto apagado na fatia, com nenhuma, aprova', () => {
    const v = julgar(entrada({ tocados: [manifestoDe('b')], corpo: 'Ordem entre edges: nenhuma', paresNaBase: pares({ b: ['a'] }) }));
    expect(marcas(v)).toEqual(['ORDEM_DECLARADA_NENHUMA']);
  });

  it('[JULG_ACHADOS_ACUMULAM] cada par com problema vira um achado', () => {
    const v = julgar(entrada({ tocados: duasEdges, corpo: 'Ordem entre edges: a → b; c → d', paresNoHead: pares({ d: ['a'] }) }));
    expect(marcas(v)).toEqual(['ORDEM_MANIFESTO_AUSENTE', 'ORDEM_MANIFESTO_SEM_PAR']);
  });
});

describe('formatarVeredito — o que o log do CI mostra', () => {
  it('[FMT_MARCA_NO_INICIO] cada achado começa pela marca, e o aprovado imprime a dele', () => {
    const reprovado = julgar({
      corpo: 'Ordem entre edges: a → b; c → d',
      tocados: [corpoDe('a'), corpoDe('b')],
      edgesNoHead: new Set(['a', 'b', 'c', 'd']),
      paresNoHead: new Map([['d', new Set(['a'])]]),
      paresNaBase: new Map(),
      ilegiveisNoHead: new Map(),
      ilegiveisNaBase: new Map(),
    });
    const linhas = formatarVeredito(reprovado).split('\n');
    expect(linhas.some((l) => l.startsWith('ORDEM_MANIFESTO_AUSENTE'))).toBe(true);
    expect(linhas.some((l) => l.startsWith('ORDEM_MANIFESTO_SEM_PAR'))).toBe(true);

    const aprovado = julgar({ ...{ corpo: '', tocados: [], edgesNoHead: new Set<string>() }, paresNoHead: new Map(), paresNaBase: new Map(), ilegiveisNoHead: new Map(), ilegiveisNaBase: new Map() });
    expect(formatarVeredito(aprovado).split('\n')[0]).toMatch(/^ORDEM_NAO_EXIGIDA\b/);
  });
});
