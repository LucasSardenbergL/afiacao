import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CallButton } from '../CallButton';

// Mock o Dialer in-app pra não puxar a árvore de telefonia (WebRTC/supabase).
vi.mock('../Dialer', () => ({
  Dialer: (props: { phoneNumber: string; customerName: string; compact?: boolean }) => (
    <div data-testid="inapp-dialer" data-phone={props.phoneNumber} data-compact={String(!!props.compact)}>
      dialer in-app
    </div>
  ),
}));

describe('CallButton', () => {
  it('usa SEMPRE o dialer in-app (WebRTC) e NUNCA um link tel: — em qualquer dispositivo', () => {
    const { container } = render(<CallButton phone="37999998888" customerName="Cliente X" />);

    expect(screen.getByTestId('inapp-dialer')).toBeInTheDocument();
    // Antes, em touch (celular/tablet), o botão caía pro discador nativo via href=tel:,
    // perdendo gravação + copiloto. Agora a ligação de venda roda sempre in-app via
    // WebRTC → nunca pode haver link tel:, em nenhum dispositivo.
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('variant="icon" passa compact=true pro Dialer', () => {
    render(<CallButton phone="37999998888" customerName="Cliente X" variant="icon" />);
    expect(screen.getByTestId('inapp-dialer').getAttribute('data-compact')).toBe('true');
  });
});
