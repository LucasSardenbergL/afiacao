import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EstatisticasTab } from '../EstatisticasTab';
import type { PortalStats } from '../types';

// recharts (ResponsiveContainer) usa ResizeObserver, ausente no jsdom.
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() { /* */ }
    unobserve() { /* */ }
    disconnect() { /* */ }
  });
});

const stats: PortalStats = {
  porDia: [{ dia: '2026-01-10', enviado: 3, falha: 1 }],
  bins: [{ label: '<30min', min: 0, max: 30, count: 2 }],
  topErros: [{ erro: 'timeout no portal', count: 4, ultimo: '2026-01-10T10:00:00' }],
};

function noop() { /* */ }

describe('EstatisticasTab', () => {
  it('sem stats → títulos dos gráficos e "Nenhuma falha no período."', () => {
    render(<EstatisticasTab onExportCSV={noop} />);
    expect(screen.getByText('Envios por dia (últimos 30 dias)')).toBeTruthy();
    expect(screen.getByText('Tempo até envio (últimos 30 dias)')).toBeTruthy();
    expect(screen.getByText('Nenhuma falha no período.')).toBeTruthy();
  });

  it('com stats → top falhas listadas', () => {
    render(<EstatisticasTab stats={stats} onExportCSV={noop} />);
    expect(screen.getByText('timeout no portal')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('botão de export dispara onExportCSV', () => {
    const onExportCSV = vi.fn();
    render(<EstatisticasTab stats={stats} onExportCSV={onExportCSV} />);
    fireEvent.click(screen.getByRole('button', { name: /Exportar histórico CSV/ }));
    expect(onExportCSV).toHaveBeenCalled();
  });
});
