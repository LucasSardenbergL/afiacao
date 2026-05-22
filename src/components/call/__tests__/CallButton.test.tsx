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

// Mock useIsMobile — controla o branch desktop vs mobile.
const mockIsMobile = vi.fn();
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mockIsMobile(),
}));

describe('CallButton', () => {
  beforeEach(() => {
    mockIsMobile.mockReset();
  });

  it('DESKTOP: renderiza o dialer in-app e NÃO um link tel: (a regressão do bug)', () => {
    mockIsMobile.mockReturnValue(false);
    const { container } = render(<CallButton phone="37999998888" customerName="Cliente X" />);

    expect(screen.getByTestId('inapp-dialer')).toBeInTheDocument();
    // O bug era abrir o app Telefone do Mac via href=tel: — não pode existir no desktop.
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('MOBILE: renderiza link tel: (discador nativo do celular) e NÃO o dialer in-app', () => {
    mockIsMobile.mockReturnValue(true);
    const { container } = render(<CallButton phone="37999998888" customerName="Cliente X" />);

    const telLink = container.querySelector('a[href^="tel:"]');
    expect(telLink).not.toBeNull();
    expect(telLink?.getAttribute('href')).toBe('tel:37999998888');
    expect(screen.queryByTestId('inapp-dialer')).toBeNull();
  });

  it('variant="icon" no desktop passa compact=true pro Dialer', () => {
    mockIsMobile.mockReturnValue(false);
    render(<CallButton phone="37999998888" customerName="Cliente X" variant="icon" />);
    expect(screen.getByTestId('inapp-dialer').getAttribute('data-compact')).toBe('true');
  });
});
