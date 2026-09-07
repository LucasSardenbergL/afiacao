import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Guard do detalhe do pedido de afiação — "Pedido não encontrado" não pode ser o que a
 * falha de leitura diz.
 *
 * NOTA SOBRE O DENOMINADOR: esta tela lê `orders`, que tem 0 linhas, enquanto
 * `sales_orders` tem 31.248. O zero é VERDADE, não erro de medição — o escritor confirma
 * (`OrderDetail.tsx` faz `.from('orders').update(...)` ao aprovar o orçamento). É uma tela
 * VIVA em código e MORTA em dados, e por isso o fix sai agora, de graça
 * (docs/historico/o-check-verde-que-a-falha-acende.md, achado 5 e item 4).
 *
 * O `.maybeSingle()` PRESERVA a diferença — `null` = este pedido não existe, `undefined` =
 * loading ou erro — e o `if (!order)` a descartava. A query roda de verdade; só o
 * `supabase` é mockado.
 */

const ORDER_ID = 'pedido-1';

type Resposta = { data: unknown; error: unknown };
let respostas: Record<string, Resposta> = {};

function encadear(chave: string) {
  const resolver = () => Promise.resolve(respostas[chave] ?? { data: null, error: null });
  const chain: Record<string, unknown> = {
    then: (ok: unknown, falha: unknown) => resolver().then(ok as never, falha as never),
  };
  for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'maybeSingle', 'single', 'update']) {
    chain[m] = () => chain;
  }
  return chain;
}

// <OrderChat> abre um canal realtime no caminho feliz; sem `channel`/`removeChannel` o
// efeito lança e o React desmonta a árvore inteira — o teste do "há dado" ficaria vermelho
// por infraestrutura do mock, não pelo defeito sob teste.
// O canal nasce DENTRO da factory: o `vi.mock` é içado acima dos `const` do módulo, e um
// `const` de fora cairia em TDZ quando a factory rodasse. `encadear` sobrevive por ser
// function declaration (essa sim é içada).
vi.mock('@/integrations/supabase/client', () => {
  const canal: Record<string, unknown> = {};
  canal.on = () => canal;
  canal.subscribe = () => canal;
  return {
    supabase: {
      from: (tabela: string) => encadear(tabela),
      channel: () => canal,
      removeChannel: () => {},
    },
  };
});

// O caminho feliz monta <OrderChat>, que chama `useAuth()` e explode fora do AuthProvider.
// Mockar a identidade não afrouxa o guard: o que está sob teste é a tradução
// "leitura falhou" → tela, e ela não passa por auth.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'cliente-1' }, isMaster: false, isStaff: false }),
}));

import OrderDetail from '../OrderDetail';

const PEDIDO = {
  id: 'abcdef1234567890',
  user_id: 'cliente-1',
  items: [],
  status: 'aprovado',
  delivery_option: 'retirada',
  time_slot: null,
  subtotal: 100,
  delivery_fee: 0,
  total: 100,
  notes: null,
  address: null,
  created_at: '2026-09-01T12:00:00Z',
  updated_at: '2026-09-01T12:00:00Z',
};

const NAO_ENCONTRADO = /Pedido não encontrado/i;

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/pedido/${ORDER_ID}`]}>
        <Routes>
          <Route path="/pedido/:id" element={<OrderDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  respostas = {};
  onlineManager.setOnline(true);
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe('OrderDetail — "não encontrado" volta a significar não encontrado', () => {
  it('o pedido EXISTE → a tela mostra o pedido, sem aviso', async () => {
    respostas.orders = { data: PEDIDO, error: null };
    renderizar();
    await waitFor(() => expect(screen.getByText(/#ABCDEF12/)).toBeInTheDocument());
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('o pedido NÃO EXISTE (maybeSingle devolveu null) → "não encontrado", sem aviso', async () => {
    respostas.orders = { data: null, error: null };
    renderizar();
    await waitFor(() => expect(screen.getByText(NAO_ENCONTRADO)).toBeInTheDocument());
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
  });

  it('a LEITURA FALHOU → aviso, e NUNCA "Pedido não encontrado"', async () => {
    respostas.orders = { data: null, error: { code: 'PGRST301', message: 'JWT expired' } };
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'erro');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });

  it('SEM REDE (pending+paused, o 4º estado) → aviso de sem-rede, e NUNCA o não-achado', async () => {
    respostas.orders = { data: PEDIDO, error: null };
    onlineManager.setOnline(false);
    renderizar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso).toHaveAttribute('data-estado', 'sem-rede');
    expect(screen.queryByText(NAO_ENCONTRADO)).toBeNull();
  });
});
