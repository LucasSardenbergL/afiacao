import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PendentesTab } from '../PendentesTab';
import type { PedidoRow } from '../types';

const row: PedidoRow = {
  id: 123, empresa: 'OBEN', fornecedor_nome: 'SAYERLACK', data_ciclo: '2026-01-10',
  num_skus: 5, valor_total: 1000, status: 'disparado', status_envio_portal: 'pendente_envio_portal',
  aprovado_em: '2026-01-10T10:00:00', enviado_portal_em: null, portal_tentativas: 1,
  portal_proximo_retry_em: null, portal_protocolo: null, portal_screenshot_url: null, portal_erro: null,
};

function noop() { /* */ }

function renderTab(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('PendentesTab', () => {
  it('vazio → mensagem', () => {
    renderTab(<PendentesTab loading={false} rows={[]} busca="" setBusca={noop} onOpenDrawer={noop} />);
    expect(screen.getByText('Nenhum pedido pendente.')).toBeTruthy();
  });

  it('com pedido → ID, valor e Ver detalhes dispara onOpenDrawer', () => {
    const onOpenDrawer = vi.fn();
    renderTab(<PendentesTab loading={false} rows={[row]} busca="" setBusca={noop} onOpenDrawer={onOpenDrawer} />);
    expect(screen.getByText('#123')).toBeTruthy();
    expect(screen.getByText(/1\.000,00/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }));
    expect(onOpenDrawer).toHaveBeenCalledWith(123);
  });

  it('digitar busca chama setBusca', () => {
    const setBusca = vi.fn();
    renderTab(<PendentesTab loading={false} rows={[]} busca="" setBusca={setBusca} onOpenDrawer={noop} />);
    fireEvent.change(screen.getByPlaceholderText('Buscar por ID…'), { target: { value: '123' } });
    expect(setBusca).toHaveBeenCalledWith('123');
  });
});
