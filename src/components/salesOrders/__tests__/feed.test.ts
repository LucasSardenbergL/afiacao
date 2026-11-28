import { describe, it, expect } from 'vitest';
import {
  feedRowDaLinha, mensagemDoErroDaLista, padraoBuscaFeed, mapSalesDetail, mapAfiacaoDetail, dedupeFeedRows, corteDoPeriodo, filtroDoPeriodo, orDoCorte,
  filtrosDoRecorte, paramsTotalDoRecorte, termoBuscaFeed, textoValorRecorte, valorDaResposta, type RecorteFeed,
} from '../feed';
import type { OrderFeedRow } from '../types';

const row = (p: Partial<OrderFeedRow> = {}): OrderFeedRow => ({
  origin: 'sales',
  id: 'r1',
  created_at: '2026-06-02T21:00:00Z',
  account: 'oben',
  order_number: '0000123',
  omie_pedido_id: 9,
  customer_user_id: 'u1',
  customer_name: 'ACME LTDA',
  item_names: ['Verniz PU', 'Catalisador'],
  item_quantity: 3,
  origem_omie: false,
  status: 'enviado',
  subtotal: 100,
  total: 100,
  ...p,
});

// A busca agora é no servidor (coluna `busca` da view — os casos de conteúdo moram na prova PG17
// db/test-order-feed-view.sh e no teste do hook). Aqui, o termo que vai no `.ilike`.
describe('padraoBuscaFeed — o termo como a coluna busca o guarda', () => {
  it('minúsculas e sem acento (casa com a coluna normalizada pela view)', () => {
    expect(padraoBuscaFeed('AFIAÇÃO Serra')).toBe('%afiacao serra%');
    expect(padraoBuscaFeed('Pôr do Sol')).toBe('%por do sol%');
  });
  it('apara as pontas e mantém o miolo (busca de frase, não de palavras soltas)', () => {
    expect(padraoBuscaFeed('  m&m moveis  ')).toBe('%m&m moveis%');
  });
  it('número e valor em formato BR passam como estão (a coluna tem "250.50" e "250,50")', () => {
    expect(padraoBuscaFeed('0000777')).toBe('%0000777%');
    expect(padraoBuscaFeed('250,50')).toBe('%250,50%');
  });
  it('curingas do usuário saem; vazio ou só-curinga = sem filtro (null), nunca match-all', () => {
    expect(padraoBuscaFeed('50%_off*')).toBe('%50off%');
    expect(padraoBuscaFeed('')).toBeNull();
    expect(padraoBuscaFeed('   ')).toBeNull();
    expect(padraoBuscaFeed('%*_')).toBeNull();
  });
});

describe('mapSalesDetail', () => {
  it('items não-array (jsonb malformado) vira [] MARCADO ilegível — não é "sem itens" (#27)', () => {
    // (o.items || []).map quebraria: ({} || []) é {} e não tem .map — achado do codex. O [] fica para a
    // tela não crashar; a marca impede o painel de dizer "sem itens" e o documento de sair vazio.
    const o = mapSalesDetail({ id: 's2', customer_user_id: 'u1', account: 'oben', items: {}, subtotal: 0, total: 50, status: 'rascunho', created_at: 'd', notes: null } as never);
    expect(o.items).toEqual([]);
    expect(o.itensIlegiveis).toBe(true);
  });
  it('lista vazia de verdade NÃO é ilegível', () => {
    const o = mapSalesDetail({ id: 's3', customer_user_id: 'u1', account: 'oben', items: [], subtotal: 0, total: 0, status: 'rascunho', created_at: 'd', notes: null } as never);
    expect(o.items).toEqual([]);
    expect(o.itensIlegiveis).toBeUndefined();
  });

  it('preserva a linha e marca _source=sales', () => {
    const raw = {
      id: 's1', customer_user_id: 'u1', account: 'colacor',
      items: [{ descricao: 'X', quantidade: 2, valor_unitario: 50, valor_total: 100, tint_cor_id: '1247', tint_nome_cor: 'AZUL' }],
      subtotal: 100, total: 100, status: 'enviado', omie_numero_pedido: '01', omie_pedido_id: 5,
      created_at: '2026-06-01T00:00:00Z', notes: 'n', customer_address: 'Rua X', customer_phone: '37 9',
    };
    const o = mapSalesDetail(raw as never);
    expect(o._source).toBe('sales');
    expect(o.items[0].tint_cor_id).toBe('1247');
    expect(o.customer_address).toBe('Rua X');
    expect(o.total).toBe(100);
  });
});

describe('mapAfiacaoDetail', () => {
  it('normaliza items (category||name, quantity default 1) e account colacor_sc', () => {
    const raw = {
      id: 'o1', user_id: 'u1', status: 'em_afiacao', subtotal: 0, total: 50,
      created_at: '2026-06-01T00:00:00Z', notes: null,
      items: [{ category: 'Afiacao Serra', quantity: 2, unitPrice: 25 }, { name: 'Faca', unitPrice: 10 }],
    };
    const o = mapAfiacaoDetail(raw as never);
    expect(o._source).toBe('afiacao');
    expect(o.account).toBe('colacor_sc');
    expect(o.customer_user_id).toBe('u1');
    expect(o.items).toEqual([
      { descricao: 'Afiacao Serra', quantidade: 2, valor_unitario: 25, valor_total: 50 },
      { descricao: 'Faca', quantidade: 1, valor_unitario: 10, valor_total: 10 },
    ]);
    expect(o.subtotal).toBe(50); // subtotal 0 → cai pro total
    expect(o.omie_numero_pedido).toBeNull();
  });
  it('items não-array não quebra e fica MARCADO ilegível (#27)', () => {
    const o = mapAfiacaoDetail({ id: 'o2', user_id: 'u1', status: 'x', subtotal: 0, total: 0, created_at: 'd', notes: null, items: {} } as never);
    expect(o.items).toEqual([]);
    expect(o.itensIlegiveis).toBe(true);
  });
  it('preço de serviço 0 é "a orçar" (null), a régua da criação (#11)', () => {
    const o = mapAfiacaoDetail({ id: 'o4', user_id: 'u1', status: 'x', subtotal: 0, total: 0, created_at: 'd', notes: null, items: [{ category: 'Serra', quantity: 2, unitPrice: 0 }] } as never);
    expect(o.items[0].valor_unitario).toBeNull();
    expect(o.items[0].valor_total).toBeNull();
    expect(o.itensIlegiveis).toBeUndefined();
  });
  it('quantity 0 real é preservado (não vira 1) — alinha com a view', () => {
    const o = mapAfiacaoDetail({ id: 'o3', user_id: 'u1', status: 'x', subtotal: 0, total: 0, created_at: 'd', notes: null, items: [{ category: 'X', quantity: 0, unitPrice: 10 }] } as never);
    expect(o.items[0].quantidade).toBe(0);
    expect(o.items[0].valor_total).toBe(0);
  });
});

describe('mapSalesDetail — procedência Omie no painel (revisão /sales #5)', () => {
  const base = { id: 's9', customer_user_id: 'u1', account: 'oben', items: [], subtotal: 0, total: 0, status: 'separacao', created_at: 'd', notes: null };
  it('hash omie_* = origem Omie; hash do app/nulo = não; hash não lido = sem marca', () => {
    expect(mapSalesDetail({ ...base, hash_payload: 'omie_oben_1' } as never).origem_omie).toBe(true);
    expect(mapSalesDetail({ ...base, hash_payload: 'abc123' } as never).origem_omie).toBe(false);
    expect(mapSalesDetail({ ...base, hash_payload: null } as never).origem_omie).toBe(false);
    expect(mapSalesDetail(base as never).origem_omie).toBeUndefined();
    expect('hash_payload' in mapSalesDetail({ ...base, hash_payload: 'omie_oben_1' } as never)).toBe(false);
  });
});

describe('dedupeFeedRows', () => {
  it('remove duplicata por (origin,id) preservando a 1ª ocorrência e a ordem', () => {
    const a = row({ id: 'x', origin: 'sales', total: 1 });
    const dup = row({ id: 'x', origin: 'sales', total: 2 });
    const b = row({ id: 'x', origin: 'afiacao' }); // mesmo id, origem diferente = NÃO é dup
    expect(dedupeFeedRows([a, dup, b])).toEqual([a, b]);
  });
  it('lista sem duplicatas passa intacta', () => {
    const rows = [row({ id: '1' }), row({ id: '2' })];
    expect(dedupeFeedRows(rows)).toEqual(rows);
  });
});

describe('valor do recorte — params, resposta e texto (ausente ≠ zero)', () => {
  const recorte = (p: Partial<RecorteFeed> = {}): RecorteFeed => ({
    empresa: 'all', status: 'todos', corte: null, cliente: null, busca: null, vendedor: null, ...p,
  });
  const brl = (v: number | null) => (v === null ? '—' : `R$ ${v.toFixed(2)}`);

  it('o corte estruturado e o .or() da lista saem dos MESMOS instantes', () => {
    const agora = new Date(2026, 10, 23, 15);
    const corte = corteDoPeriodo('7d', agora)!;
    expect(filtroDoPeriodo('7d', agora)).toBe(orDoCorte(corte));
    expect(paramsTotalDoRecorte(recorte({ corte }))).toMatchObject({ p_desde: corte.desde, p_puros: corte.puros });
    expect(corteDoPeriodo('tudo', agora)).toBeNull();
  });

  it('#31: o período tem FIM exclusivo — meia-noite local de amanhã e as datas-puras de amanhã fora', () => {
    const agora = new Date(2026, 10, 10, 15);
    const amanha = new Date(2026, 10, 11).getTime();
    for (const periodo of ['hoje', '7d', '30d'] as const) {
      const corte = corteDoPeriodo(periodo, agora)!;
      expect(new Date(corte.ate).getTime()).toBe(amanha);
      // Cada data-pura do fim é 00:00Z/12:00Z do dia 11 E cai antes do fim (em SP: só a 00:00Z = 21h do dia 10).
      for (const p of corte.purosFim) {
        expect([Date.UTC(2026, 10, 11, 0), Date.UTC(2026, 10, 11, 12)]).toContain(new Date(p).getTime());
        expect(new Date(p).getTime()).toBeLessThan(amanha);
      }
      const filtros = filtrosDoRecorte(recorte({ corte }));
      expect(filtros).toContainEqual({ op: 'lt', coluna: 'created_at', valor: corte.ate });
      expect(filtros.filter((f) => f.op === 'neq')).toEqual(corte.purosFim.map((valor) => ({ op: 'neq', coluna: 'created_at', valor })));
      expect(paramsTotalDoRecorte(recorte({ corte }))).toMatchObject({ p_ate: corte.ate, p_puros_fim: corte.purosFim });
    }
    // Sem período não há fim: nada de .lt/.neq e os parâmetros somem do JSON.
    expect(filtrosDoRecorte(recorte()).some((f) => f.op === 'lt' || f.op === 'neq')).toBe(false);
    expect(paramsTotalDoRecorte(recorte()).p_ate).toBeUndefined();
  });

  it('"Todos" vai OMITIDO (DEFAULT NULL; = ANY(\'{}\') não acharia nada); chips viram a lista do filtro', () => {
    expect(paramsTotalDoRecorte(recorte()).p_status).toBeUndefined();
    // Ausente some do JSON do PostgREST → o DEFAULT NULL da RPC vale; nenhum filtro vai como null.
    const vazio = JSON.parse(JSON.stringify(paramsTotalDoRecorte(recorte({ empresa: 'all', cliente: null, busca: null, vendedor: null }))));
    expect(vazio).toEqual({});
    expect(paramsTotalDoRecorte(recorte({ status: 'rascunhos' })).p_status).toEqual(['rascunho']);
    expect(paramsTotalDoRecorte(recorte({ status: 'faturados' })).p_status).toEqual(['faturado', 'entregue']);
    expect(paramsTotalDoRecorte(recorte({ empresa: 'oben', vendedor: 'u9', busca: '%x%' })))
      .toMatchObject({ p_account: 'oben', p_vendedor: 'u9', p_busca: '%x%' });
  });

  it('resposta fora da forma LANÇA (vira erro na tela, nunca 0)', () => {
    expect(valorDaResposta([{ pedidos: 3, soma: 150.01, sem_total: 1 }])).toEqual({ estado: 'ok', pedidos: 3, soma: 150.01, semTotal: 1 });
    expect(valorDaResposta([{ pedidos: 0, soma: null, sem_total: 0 }]).soma).toBeNull();
    expect(() => valorDaResposta([])).toThrow('order_feed_total: resposta sem linha');
    expect(() => valorDaResposta([{ pedidos: 1, soma: '10', sem_total: 0 }])).toThrow('order_feed_total: resposta fora da forma');
    expect(() => valorDaResposta([{ pedidos: 1, soma: 10 }])).toThrow('order_feed_total: resposta fora da forma');
  });

  it('texto: vazio, todos sem valor, parcial, zero conhecido, carregando e erro', () => {
    expect(textoValorRecorte({ estado: 'ok', pedidos: 0, soma: null, semTotal: 0 }, brl)).toEqual({ valor: '—', detalhe: '0 pedidos' });
    expect(textoValorRecorte({ estado: 'ok', pedidos: 2, soma: null, semTotal: 2 }, brl)).toEqual({ valor: '—', detalhe: '2 pedidos sem valor' });
    expect(textoValorRecorte({ estado: 'ok', pedidos: 3, soma: 150, semTotal: 1 }, brl))
      .toEqual({ valor: 'R$ 150.00 parcial', detalhe: '3 pedidos · 1 sem valor fora da soma' });
    expect(textoValorRecorte({ estado: 'ok', pedidos: 1, soma: 0, semTotal: 0 }, brl)).toEqual({ valor: 'R$ 0.00', detalhe: '1 pedido' });
    expect(textoValorRecorte({ estado: 'carregando' }, brl)).toEqual({ valor: '—', detalhe: null });
    expect(textoValorRecorte({ estado: 'erro' }, brl)).toEqual({ valor: '—', detalhe: 'não consegui calcular' });
  });
});

describe('termoBuscaFeed — o termo que a RPC do valor recebe', () => {
  it('sem curinga nem barra, e o padrão da lista é exatamente %termo%', () => {
    expect(termoBuscaFeed('AFIAÇÃO 50%_off*')).toBe('afiacao 50off');
    expect(termoBuscaFeed('a\\b')).toBe('ab'); // a barra seria escape no PostgREST e literal no helper SQL
    expect(padraoBuscaFeed('a\\b')).toBe('%ab%');
    expect(termoBuscaFeed('  %  ')).toBeNull(); // só espaço depois de sanitizar: sem busca nas DUAS pontas
    expect(padraoBuscaFeed('  %  ')).toBeNull();
    expect(termoBuscaFeed('')).toBeNull();
  });
});

// Revisão /sales, leva 3.
describe('leva 3 da revisão /sales', () => {
  it('#33: linha com total/subtotal ausentes é aceita (vira "—" na tela), não derruba a página', () => {
    const linha = {
      origin: 'sales', id: 'x', created_at: '2026-11-20T10:00:00Z', account: 'oben', order_number: null,
      omie_pedido_id: null, customer_user_id: 'u', customer_name: 'C', item_names: [], origem_omie: false, item_quantity: 0,
      status: 'rascunho', subtotal: null, total: null,
    };
    expect(feedRowDaLinha(linha).total).toBeNull();
  });

  it.each([
    ['sem rede', null, false, 'Sem conexão'],
    ['lente', Object.assign(new Error('x'), { name: 'LensReadOnlyError' }), true, 'lente'],
    ['permissão', { code: '42501', message: 'permission denied' }, true, 'acesso não permite'],
    ['servidor', { code: '503', message: 'x' }, true, 'servidor não respondeu'],
    ['forma inesperada', new Error('order_feed: página sem dados e sem erro'), true, 'leitura dos pedidos falhou'],
  ] as const)('#40: mensagem da tela de erro por causa (%s)', (_n, erro, online, trecho) => {
    expect(mensagemDoErroDaLista(erro, online)).toContain(trecho);
  });
});
