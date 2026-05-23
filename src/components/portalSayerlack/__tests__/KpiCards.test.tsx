import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiCards } from '../KpiCards';

describe('KpiCards', () => {
  it('sem kpis → rótulos e travessões', () => {
    render(<KpiCards />);
    expect(screen.getByText('Pendentes envio')).toBeTruthy();
    expect(screen.getByText('Taxa de sucesso 30d')).toBeTruthy();
    expect(screen.getByText('Requer conciliação')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('com kpis → valores e taxa formatada com vírgula', () => {
    render(<KpiCards kpis={{ pendentes: 5, conciliacao: 2, enviados7d: 9, taxa: 97.5 }} />);
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('97,5%')).toBeTruthy();
  });

  it('taxa null → travessão', () => {
    render(<KpiCards kpis={{ pendentes: 0, conciliacao: 0, enviados7d: 0, taxa: null }} />);
    expect(screen.getByText('Taxa de sucesso 30d')).toBeTruthy();
  });
});
