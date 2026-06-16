import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Holder hoisted pra variar plataforma (touch) e lente entre os testes.
const h = vi.hoisted(() => ({ isTouch: false, isImpersonating: false }));
const onLigar = vi.fn();
const toastInfo = vi.fn();

vi.mock('@/hooks/useIsTouchDevice', () => ({ useIsTouchDevice: () => h.isTouch }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => h.isImpersonating }));
vi.mock('sonner', () => ({ toast: { info: (...a: unknown[]) => toastInfo(...a), success: vi.fn(), error: vi.fn() } }));

// Mock do softphone WebRTC (Dialer): não puxa a árvore de telefonia (jssip/supabase) no teste.
vi.mock('../Dialer', () => ({
  Dialer: (props: { phoneNumber: string; customerName: string; compact?: boolean }) => (
    <div data-testid="inapp-dialer" data-phone={props.phoneNumber} data-compact={String(!!props.compact)}>
      softphone in-app
    </div>
  ),
}));

import { BotaoLigar } from '../BotaoLigar';

describe('BotaoLigar — híbrido: desktop(softphone) × celular(aparelho)', () => {
  beforeEach(() => {
    h.isTouch = false;
    h.isImpersonating = false;
    onLigar.mockClear();
    toastInfo.mockClear();
  });

  it('no DESKTOP renderiza o softphone WebRTC in-app e NUNCA um link tel: (resolve "não puxa o WebRTC")', () => {
    h.isTouch = false;
    const { container } = render(<BotaoLigar telefone="37999998888" nomeCliente="Cliente X" />);
    expect(screen.getByTestId('inapp-dialer')).toBeInTheDocument();
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('no CELULAR/tablet renderiza link tel: com os dígitos normalizados (liga pelo aparelho)', () => {
    h.isTouch = true;
    const { container } = render(<BotaoLigar telefone="(37) 99999-8888" nomeCliente="Cliente X" />);
    const link = container.querySelector('a[href^="tel:"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('tel:37999998888');
    expect(screen.queryByTestId('inapp-dialer')).toBeNull();
  });

  it('no CELULAR, tocar Ligar avisa que é pelo aparelho (sem gravação) e dispara onLigar', () => {
    h.isTouch = true;
    const { container } = render(
      <BotaoLigar telefone="37999998888" nomeCliente="Cliente X" onLigar={onLigar} />,
    );
    const link = container.querySelector('a[href^="tel:"]')!;
    // jsdom não implementa navegação de protocolo (tel:) e logaria um stderr ruidoso —
    // previne a ação default sem afetar o onClick do React (preventDefault ≠ stopHandler).
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(onLigar).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(String(toastInfo.mock.calls[0][0]).toLowerCase()).toContain('celular');
  });

  it('no CELULAR sob a lente "Ver como", NÃO oferece link tel: clicável (bloqueia a ligação real)', () => {
    h.isTouch = true;
    h.isImpersonating = true;
    const { container } = render(<BotaoLigar telefone="37999998888" nomeCliente="Cliente X" />);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('telefone inválido (curto/ausente) não renderiza nada — não fabrica link quebrado', () => {
    h.isTouch = true;
    const { container } = render(<BotaoLigar telefone="123" nomeCliente="Cliente X" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('variant="icon" no desktop passa compact=true pro softphone', () => {
    h.isTouch = false;
    render(<BotaoLigar telefone="37999998888" nomeCliente="Cliente X" variant="icon" />);
    expect(screen.getByTestId('inapp-dialer').getAttribute('data-compact')).toBe('true');
  });
});
