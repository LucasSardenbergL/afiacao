import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Onda 3: o que a 360 afirma em cada bloco, e quando os botões de desfecho aparecem.
const h = vi.hoisted(() => ({
  naCarteira: { data: [{ customer_user_id: 'cli-1' }] as unknown[] | null, error: null as unknown },
  carteiraQuery: [] as [string, unknown[]][],
  uso: vi.fn(),
}));

function chain() {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'limit']) c[m] = (...a: unknown[]) => { h.carteiraQuery.push([m, a]); return c; };
  c.then = (r: (v: unknown) => void) => r(h.naCarteira);
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => chain() } }));
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'vendedora-1' };
  return { useAuth: () => ({ user }) };
});
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
vi.mock('@/components/venda-cliente/BotoesContato', () => ({
  BotoesContato: ({ compradorId }: { compradorId: string }) => <button>desfecho de {compradorId}</button>,
}));
vi.mock('@/lib/nav/sensor-clientes', () => ({ registrarUsoClientes: h.uso }));

import { AcoesDaFicha } from '../AcoesDaFicha';

type Props = Parameters<typeof AcoesDaFicha>[0];
let props: Omit<Props, 'customerId'>;
const criar = vi.fn();
const renderiza = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AcoesDaFicha customerId="cli-1" {...props} /></QueryClientProvider>);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.carteiraQuery.length = 0;
  h.naCarteira = { data: [{ customer_user_id: 'cli-1' }], error: null };
  props = {
    tarefas: { data: [], isError: false },
    credito: { data: { semConta: false, conflito: false, aliasesConferidos: false, alerta: null, frescor: [{ company: 'oben', syncAt: '2026-11-22T10:00:00Z', estado: 'ok' }] }, isError: false },
    onCriarTarefa: criar,
  };
});

describe('AcoesDaFicha', () => {
  it('cliente na carteira (elegível, do usuário REAL): mostra os botões de desfecho e mede a ação', async () => {
    renderiza();
    fireEvent.click(await screen.findByText('desfecho de cli-1'));
    expect(h.uso).toHaveBeenCalledWith({ acao: 'ficha_acao', ficha: '360', tipo: 'registrar_desfecho' });
    expect(h.carteiraQuery).toContainEqual(['eq', ['owner_user_id', 'vendedora-1']]);
    expect(h.carteiraQuery).toContainEqual(['eq', ['eligible', true]]);
  });

  it('fora da carteira: sem botões, com o motivo', async () => {
    h.naCarteira = { data: [], error: null };
    renderiza();
    expect(await screen.findByText(/registrado por quem tem este cliente na carteira/)).toBeTruthy();
    expect(screen.queryByText(/desfecho de/)).toBeNull();
  });

  it('próxima ação vazia diz "visível para você"; falha diz indisponível', () => {
    renderiza();
    expect(screen.getByTestId('c360-sem-tarefa').textContent).toContain('visível para você');
  });

  it('tarefas com falha não viram "nenhuma tarefa"', () => {
    props.tarefas = { data: undefined, isError: true };
    renderiza();
    expect(screen.queryByTestId('c360-sem-tarefa')).toBeNull();
    expect(screen.getByText(/Tarefas indisponíveis/)).toBeTruthy();
  });

  it('crédito com falha não vira "nada vencido"', () => {
    props.credito = { data: undefined, isError: true };
    renderiza();
    expect(screen.getByTestId('c360-credito').textContent).toContain('indisponível');
  });

  it('aliases não conferidos: a ficha avisa que a soma pode ser parcial', () => {
    renderiza();
    expect(screen.getByText(/pode ser parcial/)).toBeTruthy();
  });

  it('tarefas atrasadas aparecem marcadas', () => {
    props.tarefas = { data: [{ id: 't1', descricao: 'Ligar sobre o orçamento', atrasada: true, effective_due: '2026-11-01' }], isError: false };
    renderiza();
    expect(screen.getByText('Ligar sobre o orçamento')).toBeTruthy();
    expect(screen.getByText('atrasada')).toBeTruthy();
  });

  it('"Tarefa" pede a criação à página e mede; sem onCriarTarefa não há botão', () => {
    const { unmount } = renderiza();
    fireEvent.click(screen.getByRole('button', { name: /Tarefa/ }));
    expect(criar).toHaveBeenCalledTimes(1);
    expect(h.uso).toHaveBeenCalledWith({ acao: 'ficha_acao', ficha: '360', tipo: 'criar_tarefa' });
    unmount();
    props.onCriarTarefa = undefined;
    renderiza();
    expect(screen.queryByRole('button', { name: /Tarefa/ })).toBeNull();
  });
});
