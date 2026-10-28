import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Plano v3, item 4: 52 NF-e `efetivado` sem nenhuma linha em `nfe_recebimento_itens` (recebidas
 * direto no Omie e fechadas pelo `omie-nfe-reconcile`). A lista e o histórico mostravam "0 itens";
 * a conferência, "0 de 0 unidades" e "Itens (0)". Ausente ≠ zero: a nota tem mercadoria, o app é
 * que não tem os itens. Decisão do founder: rótulo "Recebida fora do app", sem backfill.
 *
 * A tela roda de verdade; só o `supabase` é mockado.
 */

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(tabela: string) {
  const resolver = () => Promise.resolve(respostas[tabela] ?? { data: [], error: null });
  const chain = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    order: () => resolver(),
    maybeSingle: () => resolver(),
    single: () => resolver(),
    then: (ok: unknown, falha: unknown) => resolver().then(ok as never, falha as never),
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => {
  const canal = { on: () => canal, subscribe: () => canal };
  return {
    supabase: {
      from: (t: string) => encadear(t),
      rpc: () => Promise.resolve({ data: null, error: null }),
      channel: () => canal,
      removeChannel: () => undefined,
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    },
  };
});
vi.mock('@/hooks/useOfflineMutation', () => ({
  useOfflineMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/components/recebimento/LoteScannerOCR', () => ({ default: () => null }));

import Recebimento from '../Recebimento';
import RecebimentoConferencia from '../RecebimentoConferencia';

const ARMAZEM = { id: 'wh-1', code: 'OBEN', name: 'Oben', is_active: true };

function nf(id: string, numero: string, status: string, itens: unknown[]) {
  return {
    id,
    numero_nfe: numero,
    serie_nfe: '1',
    razao_social_emitente: 'Sayerlack Ind. e Com.',
    data_emissao: '2026-08-10',
    valor_total: 4321.5,
    status,
    omie_id_receb: 99,
    warehouse_id: ARMAZEM.id,
    nfe_recebimento_itens: itens,
    cte_associados: [],
  };
}

const ITEM = { id: 'it-1', status_item: 'conferido', quantidade_conferida: 2, quantidade_esperada: 2 };
const FORA = /Recebida fora do app/;
const ZERO_ITENS = /\b0 itens\b/;

function cliente() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderizarLista(statusFilter?: string[]) {
  return render(
    <QueryClientProvider client={cliente()}>
      <MemoryRouter>
        <Recebimento statusFilter={statusFilter} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderizarConferencia(id: string) {
  return render(
    <QueryClientProvider client={cliente()}>
      <MemoryRouter initialEntries={[`/recebimento/${id}`]}>
        <Routes>
          <Route path="/recebimento/:id" element={<RecebimentoConferencia />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  respostas = { warehouses: { data: [ARMAZEM], error: null } };
});

describe('Recebimento (lista e histórico) — NF-e efetivada sem itens', () => {
  it('efetivada sem itens → "Recebida fora do app", nunca "0 itens"', async () => {
    respostas.nfe_recebimentos = { data: [nf('a', '000512', 'efetivado', [])], error: null };
    renderizarLista(['efetivado', 'conferido']);
    const rotulo = await screen.findByTestId('nf-recebida-fora-do-app');
    expect(rotulo).toHaveTextContent(FORA);
    expect(screen.queryByText(ZERO_ITENS)).toBeNull();
    // O valor é do cabeçalho fiscal da NF-e, não somado de item: continua na tela.
    expect(screen.getByText(/4\.321,50/)).toBeInTheDocument();
  });

  it('efetivada COM itens → contagem normal, sem o rótulo', async () => {
    respostas.nfe_recebimentos = { data: [nf('b', '000777', 'efetivado', [ITEM])], error: null };
    renderizarLista(['efetivado', 'conferido']);
    await screen.findByText(/1 de 1 conferidos/);
    expect(screen.getByText(/^1 item$/)).toBeInTheDocument();
    expect(screen.queryByText(FORA)).toBeNull();
  });

  it('pendente sem itens → "Itens não carregados", nem "0 itens" nem "fora do app"', async () => {
    respostas.nfe_recebimentos = { data: [nf('c', '000888', 'pendente', [])], error: null };
    renderizarLista();
    await screen.findByTestId('nf-itens-nao-carregados');
    expect(screen.queryByText(ZERO_ITENS)).toBeNull();
    expect(screen.queryByText(FORA)).toBeNull();
  });
});

describe('RecebimentoConferencia — NF-e efetivada sem itens aberta por URL', () => {
  it('mostra "Recebida fora do app", sem "0 de 0 unidades" nem "Itens (0)"', async () => {
    respostas.nfe_recebimentos = { data: nf('d', '000999', 'efetivado', []), error: null };
    renderizarConferencia('d');
    await waitFor(() => expect(screen.getAllByText(FORA).length).toBeGreaterThan(0));
    expect(screen.queryByText(/0 de 0 unidades/)).toBeNull();
    expect(screen.queryByText(/Itens \(0\)/)).toBeNull();
    expect(screen.queryByText(/Finalizar/)).toBeNull();
  });
});
