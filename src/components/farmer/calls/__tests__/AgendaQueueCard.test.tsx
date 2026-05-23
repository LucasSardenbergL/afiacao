import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgendaQueueCard } from '../AgendaQueueCard';
import type { AgendaItem, ClientScore } from '@/hooks/useFarmerScoring';

// Mock do Dialer pra não puxar feature-flag / contexto de chamada nos testes.
vi.mock('@/components/call/Dialer', () => ({
  Dialer: ({ phoneNumber, onCallEnd }: { phoneNumber: string; onCallEnd: (d: { duration: number; state: string; audioLink: string | null }) => void }) => (
    <button onClick={() => onCallEnd({ duration: 42, state: 'finished', audioLink: null })}>
      dialer-{phoneNumber}
    </button>
  ),
}));

const item: AgendaItem = {
  customer_user_id: 'u1',
  customer_name: 'Cliente Alpha',
  priorityScore: 87.4,
  agendaType: 'risco',
  healthClass: 'critico',
};

function noop() { /* */ }

describe('AgendaQueueCard', () => {
  it('agenda vazia → mensagem de "bom trabalho"', () => {
    render(
      <AgendaQueueCard
        agenda={[]} clientScores={[]} agendaLoading={false}
        onCallEnd={noop} onRegister={noop}
      />,
      { wrapper: TooltipProvider }
    );
    expect(screen.getByText(/Nenhuma ligação pendente na agenda/)).toBeTruthy();
  });

  it('título "Próximas ligações" sempre presente', () => {
    render(
      <AgendaQueueCard
        agenda={[]} clientScores={[]} agendaLoading
        onCallEnd={noop} onRegister={noop}
      />,
      { wrapper: TooltipProvider }
    );
    expect(screen.getByText('Próximas ligações')).toBeTruthy();
  });

  it('item sem telefone → mostra nome, badge de tipo e Registrar; clique chama onRegister', () => {
    const onRegister = vi.fn();
    render(
      <AgendaQueueCard
        agenda={[item]} clientScores={[]} agendaLoading={false}
        onCallEnd={noop} onRegister={onRegister}
      />,
      { wrapper: TooltipProvider }
    );
    expect(screen.getByText('Cliente Alpha')).toBeTruthy();
    expect(screen.getByText('Risco')).toBeTruthy();
    expect(screen.getByText(/Prioridade: 87\.4/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Registrar/ }));
    expect(onRegister).toHaveBeenCalledWith(item, undefined);
  });

  it('item com telefone → exibe telefone, renderiza Dialer e encaminha onCallEnd', () => {
    const onCallEnd = vi.fn();
    const score = { customer_user_id: 'u1', customer_phone: '11999990000' } as unknown as ClientScore;
    render(
      <AgendaQueueCard
        agenda={[item]} clientScores={[score]} agendaLoading={false}
        onCallEnd={onCallEnd} onRegister={noop}
      />,
      { wrapper: TooltipProvider }
    );
    expect(screen.getByText('11999990000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /dialer-11999990000/ }));
    expect(onCallEnd).toHaveBeenCalledWith(item, '11999990000', { duration: 42, state: 'finished', audioLink: null });
  });
});
