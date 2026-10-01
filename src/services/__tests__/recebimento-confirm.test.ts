import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake mínimo de `from(t).insert(p)` e `from(t).update(p).eq(c, v)` que REGISTRA cada escrita. O
// defeito desta classe é coluna inexistente no payload (PGRST204: nada grava), então é o payload
// que se assere.
interface Escrita { tabela: string; op: 'insert' | 'update'; payload: unknown; filtro?: [string, unknown] }
const escritas: Escrita[] = [];
const erroPorTabela = new Map<string, unknown>();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => ({
      insert: (payload: unknown) => {
        escritas.push({ tabela, op: 'insert', payload });
        return Promise.resolve({ error: erroPorTabela.get(tabela) ?? null });
      },
      update: (payload: unknown) => ({
        eq: (coluna: string, valor: unknown) => {
          escritas.push({ tabela, op: 'update', payload, filtro: [coluna, valor] });
          return Promise.resolve({ error: erroPorTabela.get(tabela) ?? null });
        },
      }),
    }),
  },
}));

import { confirmUnit, type ConfirmUnitVars } from '../recebimento-confirm';

const vars: ConfirmUnitVars = {
  nfeId: 'nfe-1',
  itemId: 'item-1',
  userId: 'user-1',
  loteNumero: 'L-2026-01',
  loteFabricacao: null,
  loteValidade: '2027-03-01',
  metodoLeitura: 'manual',
  newConferida: 4,
  newStatusItem: 'em_conferencia',
  updateNfeStatusToEmConferencia: false,
};

beforeEach(() => {
  escritas.length = 0;
  erroPorTabela.clear();
});

describe('confirmUnit', () => {
  it('insere o lote só com colunas de nfe_lotes_escaneados — sem nfe_recebimento_id, que a tabela não tem', async () => {
    await confirmUnit(vars);

    // O lote chega à NF-e pelo ITEM (nfe_recebimento_item_id → nfe_recebimento_itens).
    expect(escritas[0]).toStrictEqual({
      tabela: 'nfe_lotes_escaneados',
      op: 'insert',
      payload: {
        nfe_recebimento_item_id: 'item-1',
        numero_lote: 'L-2026-01',
        data_fabricacao: null,
        data_validade: '2027-03-01',
        metodo_leitura: 'manual',
        escaneado_por: 'user-1',
      },
    });
    expect(escritas[0].payload).not.toHaveProperty('nfe_recebimento_id');
  });

  it('atualiza quantidade e status do item com valores absolutos', async () => {
    await confirmUnit(vars);

    expect(escritas[1]).toStrictEqual({
      tabela: 'nfe_recebimento_itens',
      op: 'update',
      payload: { quantidade_conferida: 4, status_item: 'em_conferencia' },
      filtro: ['id', 'item-1'],
    });
  });

  it('só promove a NF-e a em_conferencia quando a flag vem ligada', async () => {
    await confirmUnit(vars);
    expect(escritas.map((e) => e.tabela)).toEqual(['nfe_lotes_escaneados', 'nfe_recebimento_itens']);

    escritas.length = 0;
    await confirmUnit({ ...vars, updateNfeStatusToEmConferencia: true });
    expect(escritas[2]).toStrictEqual({
      tabela: 'nfe_recebimentos',
      op: 'update',
      payload: { status: 'em_conferencia' },
      filtro: ['id', 'nfe-1'],
    });
  });

  it('erro no insert do lote propaga com o código do PostgREST e não toca item nem NF-e', async () => {
    erroPorTabela.set('nfe_lotes_escaneados', { code: 'PGRST204', message: 'coluna desconhecida' });

    await expect(confirmUnit({ ...vars, updateNfeStatusToEmConferencia: true })).rejects.toMatchObject({
      code: 'PGRST204',
    });
    expect(escritas.map((e) => e.tabela)).toEqual(['nfe_lotes_escaneados']);
  });
});
