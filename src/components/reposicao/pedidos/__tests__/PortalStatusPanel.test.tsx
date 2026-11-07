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

  it('Onda 5A: mostra a situação lida no portal e quando', () => {
    render(<PortalStatusPanel pedido={ped({
      status_envio_portal: 'sucesso_portal', portal_protocolo: '2141001', portal_tentativas: 1,
      portal_situacao_codigo: '1', portal_situacao_texto: '1 - Aberto', portal_situacao_protocolo: '2141001',
      portal_situacao_em: '2026-11-08T15:30:00Z',
    })} />);
    expect(screen.getByText('1 - Aberto')).toBeTruthy();
    expect(screen.queryByText(/Cancelado no portal/)).toBeNull();
  });

  it('Onda 5A: cancelado sem PO diz que o disparo está bloqueado', () => {
    render(<PortalStatusPanel pedido={ped({
      status_envio_portal: 'sucesso_portal', portal_protocolo: '2141001', portal_tentativas: 1,
      portal_situacao_codigo: '6', portal_situacao_texto: '6 - Cancelado', portal_situacao_protocolo: '2141001',
      portal_situacao_em: '2026-11-08T15:30:00Z', omie_pedido_compra_id: '0',
    })} />);
    expect(screen.getByText(/o disparo deste pedido está bloqueado/)).toBeTruthy();
  });

  it('Onda 5A: cancelado COM PO manda conferir o PO', () => {
    render(<PortalStatusPanel pedido={ped({
      status_envio_portal: 'sucesso_portal', portal_protocolo: '2141001', portal_tentativas: 1,
      portal_situacao_codigo: '6', portal_situacao_texto: '6 - Cancelado', portal_situacao_protocolo: '2141001',
      portal_situacao_em: '2026-11-08T15:30:00Z', omie_pedido_compra_id: '9988',
    })} />);
    expect(screen.getByText(/há pedido de compra no Omie/)).toBeTruthy();
  });

  it('Onda 5A: leitura de protocolo anterior é dita como tal', () => {
    render(<PortalStatusPanel pedido={ped({
      status_envio_portal: 'sucesso_portal', portal_protocolo: '2141999', portal_tentativas: 1,
      portal_situacao_codigo: '6', portal_situacao_texto: '6 - Cancelado', portal_situacao_protocolo: '2141001',
      portal_situacao_em: '2026-11-08T15:30:00Z',
    })} />);
    expect(screen.getByText(/Leitura do protocolo anterior \(2141001\)/)).toBeTruthy();
  });

  it('Onda 5A: sem observação não mostra a linha', () => {
    render(<PortalStatusPanel pedido={ped({ status_envio_portal: 'sucesso_portal', portal_protocolo: '2141001', portal_tentativas: 1 })} />);
    expect(screen.queryByText('Situação no portal')).toBeNull();
  });
});
