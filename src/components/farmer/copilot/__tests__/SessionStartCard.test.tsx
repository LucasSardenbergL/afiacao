import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionStartCard } from '../SessionStartCard';

function setup(overrides: Partial<React.ComponentProps<typeof SessionStartCard>> = {}) {
  const props: React.ComponentProps<typeof SessionStartCard> = {
    inputMode: 'voice',
    setInputMode: vi.fn(),
    selectedCustomer: '',
    setSelectedCustomer: vi.fn(),
    customers: [{ id: 'c1', name: 'ACME' }],
    isConnecting: false,
    onStart: vi.fn(),
    ...overrides,
  };
  render(<SessionStartCard {...props} />);
  return props;
}

describe('SessionStartCard', () => {
  it('modo voz: botão "Iniciar Transcrição"', () => {
    setup({ inputMode: 'voice' });
    expect(screen.getByRole('button', { name: /Iniciar Transcrição/ })).toBeTruthy();
  });

  it('modo texto: botão "Iniciar Modo Texto" + aviso', () => {
    setup({ inputMode: 'text' });
    expect(screen.getByRole('button', { name: /Iniciar Modo Texto/ })).toBeTruthy();
    expect(screen.getByText(/No modo texto, cole ou digite/)).toBeTruthy();
  });

  it('alterna modo e dispara onStart', () => {
    const props = setup({ inputMode: 'voice' });
    fireEvent.click(screen.getByRole('button', { name: /^Texto$/ }));
    expect(props.setInputMode).toHaveBeenCalledWith('text');
    fireEvent.click(screen.getByRole('button', { name: /Iniciar Transcrição/ }));
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  it('conectando: mostra "Conectando..." e desabilita', () => {
    setup({ isConnecting: true });
    const btn = screen.getByRole('button', { name: /Conectando/ });
    expect(btn).toHaveProperty('disabled', true);
  });
});
