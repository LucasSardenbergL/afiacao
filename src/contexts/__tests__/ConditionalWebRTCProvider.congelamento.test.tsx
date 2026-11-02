import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// C7 (plano v4, lote 4): com o módulo Telefonia congelado o Provider NÃO monta —
// nem o import() do chunk (jssip), nem credencial SIP, nem REGISTER. Ativo, nada muda.
const h = vi.hoisted(() => ({
  congelada: true,
  isStaff: true,
  chunkCarregado: vi.fn(),
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isStaff: h.isStaff }) }));
vi.mock('@/lib/modulos/congelamento', () => ({
  rotaCongelada: (path: string) =>
    path === '/telefonia' && h.congelada
      ? { desde: '2026-10-12', ate: '2027-01-10', motivo: 'teste', moduloId: 'telefonia-whatsapp-rota', moduloNome: 'Telefonia' }
      : null,
}));
// O factory só roda quando o import() dinâmico do ConditionalWebRTCProvider dispara:
// é o sensor de "o chunk foi pedido".
vi.mock('../WebRTCCallContext', () => {
  h.chunkCarregado();
  return {
    WebRTCCallProvider: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="provider-webrtc">{children}</div>
    ),
  };
});

import { ConditionalWebRTCProvider } from '../ConditionalWebRTCProvider';

beforeEach(() => {
  h.isStaff = true;
});

// Ordem importa: o lazy() memoiza o import por módulo — o caso congelado roda ANTES
// do primeiro caso que de fato carrega o chunk.
describe('ConditionalWebRTCProvider × congelamento da Telefonia', () => {
  it('congelado: staff vê a árvore, mas o Provider não monta e o chunk não é pedido', async () => {
    h.congelada = true;
    render(<ConditionalWebRTCProvider><p>app</p></ConditionalWebRTCProvider>);
    expect(screen.getByText('app')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('provider-webrtc')).toBeNull();
    expect(h.chunkCarregado).not.toHaveBeenCalled();
  });

  it('ativo: staff monta o Provider (recebimento passivo antes de qualquer clique)', async () => {
    h.congelada = false;
    render(<ConditionalWebRTCProvider><p>app</p></ConditionalWebRTCProvider>);
    expect(await screen.findByTestId('provider-webrtc')).toBeTruthy();
    expect(screen.getByText('app')).toBeTruthy();
    expect(h.chunkCarregado).toHaveBeenCalledTimes(1);
  });

  it('ativo, mas customer: continua sem Provider', () => {
    h.congelada = false;
    h.isStaff = false;
    render(<ConditionalWebRTCProvider><p>app</p></ConditionalWebRTCProvider>);
    expect(screen.getByText('app')).toBeTruthy();
    expect(screen.queryByTestId('provider-webrtc')).toBeNull();
  });
});
