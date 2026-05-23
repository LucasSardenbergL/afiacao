import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrintFilters } from '../PrintFilters';

function noop() { /* */ }

describe('PrintFilters', () => {
  it('renderiza tabs de período e badges das empresas', () => {
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
    expect(screen.getByText('Todos')).toBeTruthy();
    expect(screen.getByText('Manhã')).toBeTruthy();
    expect(screen.getByText('Tarde')).toBeTruthy();
    expect(screen.getByText('Oben')).toBeTruthy();
    expect(screen.getByText('Colacor')).toBeTruthy();
    expect(screen.getByText('Afiação')).toBeTruthy();
  });

  it('clicar no badge de empresa chama toggleCompany', () => {
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
    fireEvent.click(screen.getByText('Colacor'));
    expect(toggleCompany).toHaveBeenCalledWith('colacor');
  });
});
