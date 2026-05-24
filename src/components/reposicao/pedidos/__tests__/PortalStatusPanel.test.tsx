import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PortalStatusPanel } from '../PortalStatusPanel';
import type { PedidoSugerido } from '../types';

function ped(partial: Partial<PedidoSugerido>): PedidoSugerido {
  return partial as unknown as PedidoSugerido;
}

describe('PortalStatusPanel', () => {
  it('retorna null quando pedido é null', () => {
    const { container } = render(<PortalStatusPanel pedido={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('mostra label do status, protocolo e tentativas', () => {
    render(
      <PortalStatusPanel
        pedido={ped({
          status_envio_portal: 'enviado_portal',
          portal_protocolo: 'ABC123',
          portal_tentativas: 2,
          enviado_portal_em: '2026-05-20T10:30:00Z',
          portal_proximo_retry_em: null,
          portal_erro: null,
        })}
      />,
    );
    expect(screen.getByText('✓ Enviado')).toBeTruthy();
    expect(screen.getByText('ABC123')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('mostra o erro do portal quando presente', () => {
    render(
      <PortalStatusPanel
        pedido={ped({ status_envio_portal: 'falha_envio_portal', portal_erro: 'Timeout no portal', portal_tentativas: 1 })}
      />,
    );
    expect(screen.getByText('Falha')).toBeTruthy();
    expect(screen.getByText('Timeout no portal')).toBeTruthy();
  });
});
