import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CallListPanel } from '../CallListPanel';
import type { CallLog } from '../types';

const log: CallLog = {
  id: 'c1',
  customer_user_id: 'u1',
  call_type: 'cross_sell',
  call_result: 'contato_sucesso',
  duration_seconds: 60,
  follow_up_duration_seconds: 0,
  attempt_number: 1,
  revenue_generated: 500,
  margin_generated: 0,
  notes: null,
  created_at: '2026-01-15T10:30:00Z',
  customer_name: 'Cliente Alpha',
};

function noop() { /* */ }

describe('CallListPanel', () => {
  it('lista vazia (não carregando) → mensagem e contador zerado', () => {
    render(
      <CallListPanel
        filterType="all" setFilterType={noop}
        filteredLogs={[]} loadingLogs={false}
        selectedCall={null} setSelectedCall={noop}
      />
    );
    expect(screen.getByText('Nenhuma ligação registrada')).toBeTruthy();
    expect(screen.getByText('0 ligações')).toBeTruthy();
  });

  it('com logs → renderiza card e clique chama setSelectedCall', () => {
    const setSelectedCall = vi.fn();
    render(
      <CallListPanel
        filterType="all" setFilterType={noop}
        filteredLogs={[log]} loadingLogs={false}
        selectedCall={null} setSelectedCall={setSelectedCall}
      />
    );
    expect(screen.getByText('Cliente Alpha')).toBeTruthy();
    expect(screen.getByText('1 ligações')).toBeTruthy();
    fireEvent.click(screen.getByText('Cliente Alpha'));
    expect(setSelectedCall).toHaveBeenCalledWith(log);
  });

  it('com selectedCall → renderiza painel de detalhe (Gong)', () => {
    render(
      <CallListPanel
        filterType="all" setFilterType={noop}
        filteredLogs={[log]} loadingLogs={false}
        selectedCall={log} setSelectedCall={noop}
      />
    );
    // o painel de detalhe mostra placeholders próprios
    expect(screen.getByText('Próximos passos')).toBeTruthy();
    expect(screen.getByText('Receita gerada')).toBeTruthy();
  });
});
