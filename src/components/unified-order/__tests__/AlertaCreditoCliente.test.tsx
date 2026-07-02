import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AlertaCreditoCliente } from '../AlertaCreditoCliente';
import type { AlertaCredito } from '@/hooks/useAlertaCreditoCliente';

const mockUseAlerta = vi.fn();
vi.mock('@/hooks/useAlertaCreditoCliente', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/hooks/useAlertaCreditoCliente')>();
  return { ...mod, useAlertaCreditoCliente: (doc: string | null | undefined) => mockUseAlerta(doc) };
});

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...args: unknown[]) => mockTrack(...args) }));

const alerta = (over: Partial<AlertaCredito> = {}): AlertaCredito => ({
  vencido: 1234.56,
  titulos: 2,
  vencimentoMaisAntigo: '2026-03-15',
  syncAt: '2026-07-02T08:00:00Z',
  dadoDefasado: false,
  ...over,
});

describe('AlertaCreditoCliente', () => {
  beforeEach(() => {
    mockUseAlerta.mockReset();
    mockTrack.mockReset();
  });

  it('com evidência de vencido 60+ renderiza valor, títulos e recomendação', () => {
    mockUseAlerta.mockReturnValue({ data: alerta(), error: null });
    render(<AlertaCreditoCliente documento="12345678000190" />);
    expect(screen.getByTestId('alerta-credito-cliente')).toBeTruthy();
    expect(screen.getByText(/vencido há 60\+ dias/)).toBeTruthy();
    expect(screen.getByText(/2 títulos em aberto/)).toBeTruthy();
    expect(screen.getByText(/alinhar com o financeiro/)).toBeTruthy();
  });

  it('sem alerta (null) não renderiza NADA — nem "cliente OK" fabricado', () => {
    mockUseAlerta.mockReturnValue({ data: null, error: null });
    const { container } = render(<AlertaCreditoCliente documento="12345678000190" />);
    expect(container.firstChild).toBeNull();
  });

  it('erro na fonte → silêncio (não trava a venda) + track de erro', () => {
    mockUseAlerta.mockReturnValue({ data: undefined, error: new Error('boom') });
    const { container } = render(<AlertaCreditoCliente documento="12345678000190" />);
    expect(container.firstChild).toBeNull();
    expect(mockTrack).toHaveBeenCalledWith('venda.alerta_credito_erro', expect.objectContaining({ message: 'boom' }));
  });

  it('dado defasado mostra o aviso de sync velho', () => {
    mockUseAlerta.mockReturnValue({ data: alerta({ dadoDefasado: true, syncAt: null }), error: null });
    render(<AlertaCreditoCliente documento="12345678000190" />);
    expect(screen.getByText(/Sync há mais de 24h/)).toBeTruthy();
  });

  it('audita a exibição 1x por cliente (não por re-render)', () => {
    mockUseAlerta.mockReturnValue({ data: alerta(), error: null });
    const { rerender } = render(<AlertaCreditoCliente documento="12345678000190" />);
    rerender(<AlertaCreditoCliente documento="12345678000190" />);
    const exibicoes = mockTrack.mock.calls.filter((c) => c[0] === 'venda.alerta_credito_exibido');
    expect(exibicoes).toHaveLength(1);
    expect(exibicoes[0][1]).toMatchObject({ vencido: 1234.56, titulos: 2, dado_defasado: false });
  });
});
