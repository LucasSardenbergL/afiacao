import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CallDetailPanel } from '../CallDetailPanel';
import type { CallLog } from '../types';

const base: CallLog = {
  id: 'c1',
  customer_user_id: 'u1',
  call_type: 'cross_sell',
  call_result: 'contato_sucesso',
  duration_seconds: 125,
  follow_up_duration_seconds: 0,
  attempt_number: 1,
  revenue_generated: 0,
  margin_generated: 0,
  notes: null,
  created_at: '2026-01-15T10:30:00Z',
  customer_name: 'Cliente Alpha',
};

function noop() { /* */ }

describe('CallDetailPanel', () => {
  it('renderiza nome, tipo, duração e placeholders quando sem receita/notas', () => {
    render(<CallDetailPanel call={base} onClose={noop} />);
    expect(screen.getByText('Cliente Alpha')).toBeTruthy();
    expect(screen.getByText('Cross-sell')).toBeTruthy();
    expect(screen.getByText('02:05')).toBeTruthy();
    expect(screen.getByText('Nenhuma transcrição disponível')).toBeTruthy();
    expect(screen.getByText('Nenhum próximo passo registrado.')).toBeTruthy();
    // sem cards de receita/margem
    expect(screen.queryByText('Receita gerada')).toBeNull();
  });

  it('mostra métricas de receita/margem e transcrição quando presentes', () => {
    render(<CallDetailPanel call={{ ...base, revenue_generated: 1000, margin_generated: 300, notes: 'Cliente pediu orçamento' }} onClose={noop} />);
    expect(screen.getByText('Receita gerada')).toBeTruthy();
    expect(screen.getByText('Margem gerada')).toBeTruthy();
    expect(screen.getByText('Cliente pediu orçamento')).toBeTruthy();
    expect(screen.queryByText('Nenhuma transcrição disponível')).toBeNull();
  });

  it('mostra bloco de follow-up quando follow_up_duration_seconds > 0', () => {
    render(<CallDetailPanel call={{ ...base, follow_up_duration_seconds: 45 }} onClose={noop} />);
    expect(screen.getByText('Follow-up')).toBeTruthy();
    expect(screen.getByText('00:45')).toBeTruthy();
  });
});
