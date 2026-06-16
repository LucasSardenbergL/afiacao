import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../WebRTCDialer', () => ({
  WebRTCDialer: () => <div data-testid="webrtc-dialer">webrtc</div>,
}));
vi.mock('@/components/call/WebRTCDialer', () => ({
  WebRTCDialer: () => <div data-testid="webrtc-dialer">webrtc</div>,
}));

import { Dialer } from '../Dialer';

// O WebRTCDialer é montado via React.lazy + <Suspense fallback={null}> (Dialer.tsx),
// então o testid só aparece DEPOIS que a promise do lazy resolve e o React re-renderiza
// — um boundary assíncrono que o mock NÃO remove (o mock troca o chunk real por um stub,
// mas o lazy() segue resolvendo numa microtask). Na suíte completa (435 arquivos, fork
// pool) a M2 8GB satura e o worker é descheduled por >1s, então o resolve+re-render passa
// do teto DEFAULT de 1000ms do findBy → o teste falhava INTERMITENTE com "Unable to find
// element" + body vazio (isolado sempre passa em ~86ms). Teto generoso (mesma filosofia do
// testTimeout: 20000 deste projeto) elimina a falha falsa SEM afrouxar a asserção: o findBy
// retorna assim que o elemento aparece (custo zero no caminho feliz); os 5s só ampliam a
// janela tolerada sob contenção, e ficam bem abaixo do testTimeout de 20s (preserva a msg).
const LAZY_RESOLVE_TIMEOUT = 5000;

describe('Dialer', () => {
  it('renderiza SEMPRE o WebRTCDialer (Nvoip click-to-call descontinuado da UI)', async () => {
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" />);
    expect(await screen.findByTestId('webrtc-dialer', {}, { timeout: LAZY_RESOLVE_TIMEOUT })).toBeTruthy();
  });

  it('renderiza o WebRTCDialer também com floating=true', async () => {
    render(<Dialer phoneNumber="37999998888" customerName="Cliente" floating />);
    expect(await screen.findByTestId('webrtc-dialer', {}, { timeout: LAZY_RESOLVE_TIMEOUT })).toBeTruthy();
  });
});
