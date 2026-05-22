import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CallButton } from '../CallButton';

// Mock o Dialer in-app pra não puxar a árvore de telefonia (useNvoipCall/supabase).
vi.mock('../Dialer', () => ({
  Dialer: (props: { phoneNumber: string; customerName: string; compact?: boolean }) => (
    <div data-testid="inapp-dialer" data-phone={props.phoneNumber} data-compact={String(!!props.compact)}>
      dialer in-app
    </div>
  ),
}));

// Mock a detecção de dispositivo touch — controla o branch desktop/notebook vs celular.
const mockIsTouch = vi.fn();
vi.mock('@/hooks/useIsTouchDevice', () => ({
  useIsTouchDevice: () => mockIsTouch(),
}));

describe('CallButton', () => {
  beforeEach(() => {
    mockIsTouch.mockReset();
  });

  it('DESKTOP/NOTEBOOK (touch=false): renderiza o dialer in-app e NÃO um link tel: (regressão do bug)', () => {
    mockIsTouch.mockReturnValue(false);
    const { container } = render(<CallButton phone="37999998888" customerName="Cliente X" />);

    expect(screen.getByTestId('inapp-dialer')).toBeInTheDocument();
    // O bug era abrir o app Telefone do Mac via href=tel:. Notebook (mesmo janela
    // estreita) tem touch=false → nunca pode ter link tel:.
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('CELULAR/TABLET (touch=true): renderiza link tel: (discador nativo) e NÃO o dialer in-app', () => {
    mockIsTouch.mockReturnValue(true);
    const { container } = render(<CallButton phone="37999998888" customerName="Cliente X" />);

    const telLink = container.querySelector('a[href^="tel:"]');
    expect(telLink).not.toBeNull();
    expect(telLink?.getAttribute('href')).toBe('tel:37999998888');
    expect(screen.queryByTestId('inapp-dialer')).toBeNull();
  });

  it('variant="icon" no desktop passa compact=true pro Dialer', () => {
    mockIsTouch.mockReturnValue(false);
    render(<CallButton phone="37999998888" customerName="Cliente X" variant="icon" />);
    expect(screen.getByTestId('inapp-dialer').getAttribute('data-compact')).toBe('true');
  });
});
