// Onda C, item 6: o desfecho é SERIALIZADO por cliente (nenhum 2º toque enquanto o 1º grava, em nenhuma
// instância) e o sensor conta só a gravação CONFIRMADA.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let resolverRpc: (v: { error: unknown }) => void = () => undefined;
const rpcMock = vi.fn(() => new Promise<{ error: unknown }>((r) => { resolverRpc = r; }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...(a as [])) } }));
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: vi.fn(() => Promise.resolve()) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/hooks/useContatosDoDia', () => ({ useContatosDoDia: () => ({ data: new Map() }) }));
const usoMock = vi.fn();
vi.mock('@/lib/nav/sensor-clientes', () => ({ registrarUsoClientes: (u: unknown) => usoMock(u) }));

import { BotoesContato } from '../BotoesContato';
import { liberarContato } from '@/hooks/useRegistrarContato';

function renderiza() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      {/* Duas instâncias do MESMO cliente (ex.: fila + ficha da ligação): a trava vale entre elas. */}
      <div data-testid="a"><BotoesContato compradorId="cli-1" superficie="360" /></div>
      <div data-testid="b"><BotoesContato compradorId="cli-1" /></div>
    </QueryClientProvider>,
  );
}

beforeEach(() => { rpcMock.mockClear(); usoMock.mockClear(); liberarContato('cli-1'); });

describe('BotoesContato — serializa o desfecho por cliente', () => {
  it('2º toque (na mesma ou na outra instância) enquanto grava NÃO dispara outra gravação; mostra "Salvando…"', async () => {
    renderiza();
    const [vendeuA, vendeuB] = screen.getAllByRole('button', { name: /Vendeu/ });
    fireEvent.click(vendeuA);
    fireEvent.click(vendeuA); // toque duplo antes do re-render
    await waitFor(() => expect(screen.getAllByText('Salvando…').length).toBe(2));
    expect((vendeuB as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(vendeuB);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(rpcMock).toHaveBeenCalledTimes(1);
    // Ainda não confirmou: o sensor NÃO contou o desfecho.
    expect(usoMock).not.toHaveBeenCalled();
    await act(async () => { resolverRpc({ error: null }); });
    await waitFor(() => expect(screen.queryAllByText('Salvando…')).toHaveLength(0));
    expect(usoMock).toHaveBeenCalledTimes(1);
    expect(usoMock).toHaveBeenCalledWith({ acao: 'ficha_acao', ficha: '360', tipo: 'registrar_desfecho', fase: 'sucesso' });
    // Liberado depois de gravar: um novo toque grava de novo.
    await waitFor(() => expect((screen.getAllByRole('button', { name: /Vendeu/ })[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getAllByRole('button', { name: /Vendeu/ })[0]);
    // O mutationFn do TanStack roda num microtask depois do `mutate`: espera a 2ª chamada chegar.
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(2));
  });

  it('gravação que FALHA não conta no sensor e libera os botões', async () => {
    renderiza();
    fireEvent.click(screen.getAllByRole('button', { name: /Não atendeu/ })[0]);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    await act(async () => { resolverRpc({ error: { code: '42501', message: 'fora da carteira' } }); });
    await waitFor(() => expect(screen.queryAllByText('Salvando…')).toHaveLength(0));
    expect(usoMock).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getAllByRole('button', { name: /Não atendeu/ })[0] as HTMLButtonElement).disabled).toBe(false));
  });
});
