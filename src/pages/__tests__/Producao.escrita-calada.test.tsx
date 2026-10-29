import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * Guard — as duas escritas da Produção não podem anunciar sucesso sem ter gravado.
 *
 *  - `ProductionOrders`: o `.update({ status: 'in_progress' })` era `await` solto, sem olhar
 *    `error` nem as linhas afetadas ⇒ "Produção iniciada!" saía com o banco recusando
 *    (E1 do gate de escrita-crítica, que listava o arquivo na dívida).
 *  - `ProducaoBomExcecoes`: `fn_pcp_dispor_excecao` devolve `FOUND` (prod, psql-ro
 *    2026-10-27) e a tela descartava o booleano ⇒ `false` (o UPDATE não achou a linha)
 *    virava "Marcada como …" e a disposição sumia no próximo carregamento.
 *
 * As PÁGINAS rodam de verdade; só o supabase e o `sonner` são mockados.
 */
type Resposta = { data: unknown; error: { message: string } | null };

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

let respostaUpdate: Resposta = { data: [{ id: 'op-1' }], error: null };
let respostaRpc: Resposta = { data: true, error: null };
const rpc = vi.fn();

const ORDEM = {
  id: 'op-1',
  status: 'pending',
  product_codigo: 'ABR-1',
  product_descricao: 'Lixa rolo',
  quantidade: 10,
  unidade: null,
  customer_name: null,
  omie_ordem_numero: null,
  sales_order_number: null,
  created_at: '2026-10-27T12:00:00Z',
  ready_by_date: null,
  completed_at: null,
};

const EXCECAO = {
  pai_codigo: 101,
  componente_codigo: 202,
  papel: 'fita',
  pai_descricao: 'Lixa 100',
  componente_descricao: 'Fita X',
  observado: 1,
  esperado: 2,
  unidade: 'M',
  status: 'divergente',
  materializado_em: '2026-10-27T12:00:00Z',
  disposicao: null,
  disposicao_nota: null,
};

/** Builder encadeável mínimo: leitura resolve a lista; update resolve `respostaUpdate`. */
function tabela(nome: string) {
  const lista = nome === 'production_orders' ? [ORDEM] : [EXCECAO];
  const leitura = { order: () => Promise.resolve({ data: lista, error: null }) };
  return {
    select: () => leitura,
    update: () => ({ eq: () => ({ select: () => Promise.resolve(respostaUpdate) }) }),
  };
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (nome: string) => tabela(nome),
    rpc: (...a: unknown[]) => {
      rpc(...a);
      return Promise.resolve(respostaRpc);
    },
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
  },
}));

import ProductionOrders from '@/pages/ProductionOrders';
import ProducaoBomExcecoes from '@/pages/ProducaoBomExcecoes';

beforeEach(() => {
  toastSuccess.mockClear();
  toastError.mockClear();
  rpc.mockClear();
  respostaUpdate = { data: [{ id: 'op-1' }], error: null };
  respostaRpc = { data: true, error: null };
});

async function iniciarProducao() {
  render(<ProductionOrders />);
  fireEvent.click(await screen.findByRole('button', { name: /Iniciar Produção/ }));
}

describe('ProductionOrders — iniciar produção', () => {
  it('controle: update devolve a linha ⇒ sucesso', async () => {
    await iniciarProducao();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Produção iniciada!'));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('erro do banco ⇒ toast de erro, nunca sucesso', async () => {
    respostaUpdate = { data: null, error: { message: 'permission denied' } };
    await iniciarProducao();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Erro ao iniciar produção: permission denied'));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('0 linhas sem erro (RLS/ordem sumiu) ⇒ toast de erro, nunca sucesso', async () => {
    respostaUpdate = { data: [], error: null };
    await iniciarProducao();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Produção não iniciada: a ordem não foi atualizada'));
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

async function aceitarExcecao() {
  render(<ProducaoBomExcecoes />);
  fireEvent.click(await screen.findByRole('button', { name: /^Aceitar \(é assim mesmo\)$/ }));
}

describe('ProducaoBomExcecoes — dispor exceção', () => {
  it('controle: RPC devolve true ⇒ sucesso, com o componente real (sem `?? 0`)', async () => {
    await aceitarExcecao();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Marcada como "Aceita (é assim mesmo)"'));
    expect(rpc).toHaveBeenCalledWith('fn_pcp_dispor_excecao', {
      p_pai: 101,
      p_papel: 'fita',
      p_componente: 202,
      p_disposicao: 'aceitar',
      p_nota: null,
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('RPC devolve false (linha não encontrada) ⇒ toast de erro, nunca sucesso', async () => {
    respostaRpc = { data: false, error: null };
    await aceitarExcecao();
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Exceção não encontrada: a fila mudou desde o carregamento. Recarregando.'),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
