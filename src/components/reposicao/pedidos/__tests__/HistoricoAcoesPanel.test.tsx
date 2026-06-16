import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HistoricoAcoesPanel } from '../HistoricoAcoesPanel';
import type { PedidoSugerido } from '../types';

function ped(partial: Partial<PedidoSugerido>): PedidoSugerido {
  return partial as unknown as PedidoSugerido;
}

describe('HistoricoAcoesPanel', () => {
  it('retorna null quando pedido é null', () => {
    const { container } = render(<HistoricoAcoesPanel pedido={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('mostra "Sem eventos registrados" quando não há datas', () => {
    render(<HistoricoAcoesPanel pedido={ped({})} />);
    expect(screen.getByText('Sem eventos registrados.')).toBeTruthy();
  });

  it('lista eventos de geração e aprovação com o responsável', () => {
    render(
      <HistoricoAcoesPanel
        pedido={ped({
          criado_em: '2026-05-20T08:00:00Z',
          aprovado_em: '2026-05-20T09:00:00Z',
          aprovado_por: 'joao@empresa.com',
        })}
      />,
    );
    expect(screen.getByText('Pedido gerado')).toBeTruthy();
    expect(screen.getByText('Aprovado')).toBeTruthy();
    expect(screen.getByText(/por joao@empresa\.com/)).toBeTruthy();
  });

  it('mostra o protocolo no evento de envio ao portal', () => {
    render(
      <HistoricoAcoesPanel
        pedido={ped({
          enviado_portal_em: '2026-05-20T10:00:00Z',
          portal_protocolo: 'P-999',
          status_envio_portal: 'enviado_portal',
        })}
      />,
    );
    expect(screen.getByText('Enviado ao portal')).toBeTruthy();
    expect(screen.getByText('Protocolo P-999')).toBeTruthy();
  });
});
