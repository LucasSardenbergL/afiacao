import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake mínimo da cadeia `from(t).update(p).eq(c, v)` que REGISTRA cada escrita. O defeito desta
// classe é o NOME DA COLUNA no payload (o PostgREST responde PGRST204 e nada grava), então é o
// payload que se assere — "não lançou" não prova nada contra um mock.
interface Escrita { tabela: string; payload: unknown; filtro: [string, unknown] }
const escritas: Escrita[] = [];
const erroPorTabela = new Map<string, unknown>();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => ({
      update: (payload: unknown) => ({
        eq: (coluna: string, valor: unknown) => {
          escritas.push({ tabela, payload, filtro: [coluna, valor] });
          return Promise.resolve({ error: erroPorTabela.get(tabela) ?? null });
        },
      }),
    }),
  },
}));

import { reportDivergencia } from '../recebimento-divergencia';

beforeEach(() => {
  escritas.length = 0;
  erroPorTabela.clear();
});

describe('reportDivergencia', () => {
  it('grava a observação em observacao_divergencia — a coluna que existe em nfe_recebimento_itens', async () => {
    await reportDivergencia({ itemId: 'item-1', nfeId: 'nfe-1', observacao: 'Faltam 3 unidades' });

    expect(escritas[0]).toStrictEqual({
      tabela: 'nfe_recebimento_itens',
      payload: { status_item: 'divergencia', observacao_divergencia: 'Faltam 3 unidades' },
      filtro: ['id', 'item-1'],
    });
    expect(escritas[0].payload).not.toHaveProperty('observacao');
  });

  it('marca a NF-e inteira como divergencia depois do item', async () => {
    await reportDivergencia({ itemId: 'item-1', nfeId: 'nfe-1', observacao: 'x' });

    expect(escritas[1]).toStrictEqual({
      tabela: 'nfe_recebimentos',
      payload: { status: 'divergencia' },
      filtro: ['id', 'nfe-1'],
    });
  });

  it('item preso em offline_queue_v1 com as vars de antes do conserto drena gravando na coluna certa', async () => {
    // A fila persiste `variables` (JSON). O formato delas NÃO mudou com o conserto — o nome da
    // coluna vivia aqui no serviço, não no payload —, então o que estiver enfileirado drena no
    // próximo flush sem migração da fila.
    const enfileirado = JSON.parse(JSON.stringify({
      kind: 'recebimento.report-divergencia',
      variables: { itemId: 'item-9', nfeId: 'nfe-9', observacao: '2 latas amassadas' },
    }));

    await reportDivergencia(enfileirado.variables);

    expect(escritas[0].payload).toStrictEqual({
      status_item: 'divergencia',
      observacao_divergencia: '2 latas amassadas',
    });
  });

  it('erro no item propaga com o código do PostgREST e não marca a NF-e', async () => {
    erroPorTabela.set('nfe_recebimento_itens', { code: 'PGRST204', message: 'coluna desconhecida' });

    await expect(
      reportDivergencia({ itemId: 'item-1', nfeId: 'nfe-1', observacao: 'x' }),
    ).rejects.toMatchObject({ code: 'PGRST204' });
    expect(escritas.map((e) => e.tabela)).toEqual(['nfe_recebimento_itens']);
  });
});
