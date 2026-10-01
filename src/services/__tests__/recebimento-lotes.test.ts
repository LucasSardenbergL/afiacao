import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake mínimo de `from(t).select(cols).eq(c, v)` que REGISTRA a forma da leitura: o defeito era
// filtrar por uma coluna que `nfe_lotes_escaneados` não tem (o PostgREST responde 42703 e a tela
// fica sem lotes), então são o select e o filtro que se asserem.
const leituras: Array<{ tabela: string; colunas: string; filtro: [string, unknown] }> = [];
let resposta: { data: unknown; error: unknown } = { data: [], error: null };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => ({
      select: (colunas: string) => ({
        eq: (coluna: string, valor: unknown) => {
          leituras.push({ tabela, colunas, filtro: [coluna, valor] });
          return Promise.resolve(resposta);
        },
      }),
    }),
  },
}));

import { listarLotesEscaneados } from '../recebimento-lotes';

beforeEach(() => {
  leituras.length = 0;
  resposta = { data: [], error: null };
});

describe('listarLotesEscaneados', () => {
  it('filtra pela NF-e através do item (embed !inner) — nfe_lotes_escaneados não tem nfe_recebimento_id', async () => {
    await listarLotesEscaneados('nfe-1');

    expect(leituras).toHaveLength(1);
    expect(leituras[0].tabela).toBe('nfe_lotes_escaneados');
    expect(leituras[0].colunas).toContain('nfe_recebimento_itens!inner(nfe_recebimento_id)');
    expect(leituras[0].filtro).toEqual(['nfe_recebimento_itens.nfe_recebimento_id', 'nfe-1']);
  });

  it('devolve os lotes sem o objeto do embed', async () => {
    resposta = {
      data: [{
        id: 'lote-1',
        nfe_recebimento_item_id: 'item-1',
        numero_lote: 'L1',
        data_fabricacao: null,
        data_validade: '2027-03-01',
        nfe_recebimento_itens: { nfe_recebimento_id: 'nfe-1' },
      }],
      error: null,
    };

    await expect(listarLotesEscaneados('nfe-1')).resolves.toStrictEqual([{
      id: 'lote-1',
      nfe_recebimento_item_id: 'item-1',
      numero_lote: 'L1',
      data_fabricacao: null,
      data_validade: '2027-03-01',
    }]);
  });

  it('erro da leitura propaga com o código — a tela decide o estado de falha', async () => {
    resposta = { data: null, error: { code: '42703', message: 'coluna não existe' } };

    await expect(listarLotesEscaneados('nfe-1')).rejects.toMatchObject({ code: '42703' });
  });
});
