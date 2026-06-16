import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryTable } from '../HistoryTable';
import type { TintImportacaoRow } from '../types';

const row = (over: Partial<TintImportacaoRow> = {}): TintImportacaoRow => ({
  id: 'imp-1',
  tipo: 'dados_corantes',
  arquivo_nome: 'corantes.csv',
  status: 'concluido',
  total_registros: 100,
  registros_importados: 80,
  registros_atualizados: 20,
  registros_erro: 0,
  created_at: '2026-01-10T10:00:00',
  ...over,
});

function noop() { /* */ }

describe('HistoryTable', () => {
  it('renderiza linha com arquivo, registros e status', () => {
    render(<HistoryTable history={[row()]} histLoading={false} importing={false} resumingId={null} onResume={noop} />);
    expect(screen.getByText('corantes.csv')).toBeTruthy();
    expect(screen.getByText('100 / 100')).toBeTruthy();
    expect(screen.getByText('concluido')).toBeTruthy();
  });

  it('status concluido → sem botão Retomar', () => {
    render(<HistoryTable history={[row()]} histLoading={false} importing={false} resumingId={null} onResume={noop} />);
    expect(screen.queryByRole('button', { name: /Retomar/ })).toBeNull();
  });

  it('status concluido_parcial → botão Retomar dispara onResume', () => {
    const onResume = vi.fn();
    const r = row({ status: 'concluido_parcial' });
    render(<HistoryTable history={[r]} histLoading={false} importing={false} resumingId={null} onResume={onResume} />);
    fireEvent.click(screen.getByRole('button', { name: /Retomar/ }));
    expect(onResume).toHaveBeenCalledWith(r);
  });
});
