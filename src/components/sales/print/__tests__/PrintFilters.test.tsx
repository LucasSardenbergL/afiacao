import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrintFilters } from '../PrintFilters';

function noop() { /* */ }

describe('PrintFilters', () => {
  // findByText (re-tenta ~1s) em vez de getByText (consulta imediata): tolera
  // atraso de render/commit do React 18 sob carga paralela do suite completo —
  // mitiga flake raro (~5%) observado só no `bun run test` inteiro.
  it('renderiza tabs de período e badges das empresas', async () => {
    render(
      <PrintFilters
        selectedDate={new Date('2026-01-15T12:00:00')}
        setSelectedDate={noop}
        selectedPeriod="all"
        setSelectedPeriod={noop}
        selectedCompanies={['oben', 'colacor', 'afiacao']}
        toggleCompany={noop}
      />
    );
    expect(await screen.findByText('Todos')).toBeTruthy();
    expect(await screen.findByText('Manhã')).toBeTruthy();
    expect(await screen.findByText('Tarde')).toBeTruthy();
    expect(await screen.findByText('Oben')).toBeTruthy();
    expect(await screen.findByText('Colacor')).toBeTruthy();
    expect(await screen.findByText('Afiação')).toBeTruthy();
  });

  it('clicar no badge de empresa chama toggleCompany', async () => {
    const toggleCompany = vi.fn();
    render(
      <PrintFilters
        selectedDate={new Date('2026-01-15T12:00:00')}
        setSelectedDate={noop}
        selectedPeriod="all"
        setSelectedPeriod={noop}
        selectedCompanies={['oben', 'colacor', 'afiacao']}
        toggleCompany={toggleCompany}
      />
    );
    fireEvent.click(await screen.findByText('Colacor'));
    expect(toggleCompany).toHaveBeenCalledWith('colacor');
  });
});
