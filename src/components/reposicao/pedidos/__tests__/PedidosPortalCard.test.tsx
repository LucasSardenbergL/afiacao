import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Card "Pedidos do portal Sayerlack" + diálogo de importar (revisão Fable+Codex 2026-11). O supabase é mockado; os
 * componentes rodam de verdade.
 */
let respostaRpc: { data: unknown; error: unknown } = { data: null, error: null };
let respostaInvoke: { data: unknown; error: unknown } = { data: null, error: null };
const rpc = vi.fn(() => Promise.resolve(respostaRpc));
const invoke = vi.fn(() => Promise.resolve(respostaInvoke));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...(a as [])),
    functions: { invoke: (...a: unknown[]) => invoke(...(a as [])) },
  },
}));
vi.mock('@/components/execucoes/UltimaExecucao', () => ({ UltimaExecucao: () => null }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { PedidosPortalCard } from '../PedidosPortalCard';
import { ImportarPedidoPortalDialog } from '../ImportarPedidoPortalDialog';

function renderizar(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { rpc.mockClear(); invoke.mockClear(); });

describe('PedidosPortalCard', () => {
  it('mostra a pendência do cron com o motivo e o botão de importar de novo, que abre o diálogo já com o número', async () => {
    respostaRpc = { data: { pendencias: [{ protocolo: '2140762', mensagem: 'NCM 32091020 sem alíquota', tentativas: 2 }], sem_po: [], importados: [] }, error: null };
    renderizar(<PedidosPortalCard />);
    expect(await screen.findByText('Pedido 2140762')).toBeTruthy();
    expect(screen.getByText('NCM 32091020 sem alíquota')).toBeTruthy();
    expect(screen.getByText(/1 pendente/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Importar de novo' }));
    expect(((await screen.findByLabelText('Nº do pedido no portal')) as HTMLInputElement).value).toBe('2140762');
  });

  it('pedido no app sem PO aparece com link para o pedido', async () => {
    respostaRpc = { data: { pendencias: [], sem_po: [{ pedido_id: 3700, protocolo: '2141500', status: 'falha_envio' }], importados: [] }, error: null };
    renderizar(<PedidosPortalCard />);
    const link = await screen.findByRole('link', { name: '#3700' });
    expect(link.getAttribute('href')).toBe('/admin/reposicao/pedidos?id=3700');
  });

  it('sem pendência diz "Nada pendente"; leitura falha NUNCA diz isso', async () => {
    respostaRpc = { data: { pendencias: [], sem_po: [], importados: [] }, error: null };
    const { unmount } = renderizar(<PedidosPortalCard />);
    expect(await screen.findByText('Nada pendente do portal.')).toBeTruthy();
    unmount();
    respostaRpc = { data: null, error: { message: 'permission denied' } };
    renderizar(<PedidosPortalCard />);
    expect(await screen.findByText(/Não consegui ler os pedidos do portal/)).toBeTruthy();
    expect(screen.queryByText('Nada pendente do portal.')).toBeNull();
  });
});

describe('ImportarPedidoPortalDialog', () => {
  it('sucesso traz link "Abrir pedido" e a condição de pagamento', async () => {
    respostaInvoke = {
      data: { ok: true, etapa: 'concluido', pedido_id: 3644, omie_numero: '1291', valor_total: 3238.63, condicao: 'A07 · Para 7 dias', mensagem: 'ok' },
      error: null,
    };
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }));
    const link = await screen.findByRole('link', { name: /Abrir pedido #3644/ });
    expect(link.getAttribute('href')).toBe('/admin/reposicao/pedidos?id=3644');
    expect(screen.getByText('A07 · Para 7 dias')).toBeTruthy();
  });

  it('erro de transporte SEM corpo vira "não sei se entrou" (aviso), nunca "não foi importado"', async () => {
    respostaInvoke = { data: null, error: { message: 'Failed to send a request to the Edge Function' } };
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }));
    const res = await screen.findByTestId('importar-portal-resultado');
    expect(res.getAttribute('data-tom')).toBe('aviso');
    expect(screen.getByText('Não sei se o pedido 2141068 entrou')).toBeTruthy();
    expect(screen.queryByText(/não foi importado/)).toBeNull();
  });

  it('SKU sem de-para mostra o atalho para o Mapeamento de SKU', async () => {
    respostaInvoke = { data: { ok: false, etapa: 'importacao', sqlstate: 'IP002', mensagem: 'sem de-para: X' }, error: null };
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }));
    const link = await screen.findByRole('link', { name: 'Abrir Mapeamento de SKU' });
    expect(link.getAttribute('href')).toBe('/admin/sku-mapeamento');
  });

  it('durante a importação o X some e o tempo decorrido aparece', async () => {
    let soltar: (v: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((r) => { soltar = r; }));
    renderizar(<ImportarPedidoPortalDialog open onOpenChange={() => {}} protocoloInicial="2141068" />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Importar' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());
    expect(screen.getByText(/Não feche esta janela/)).toBeTruthy();
    soltar({ data: { ok: true, etapa: 'concluido', pedido_id: 1 }, error: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy());
  });
});
