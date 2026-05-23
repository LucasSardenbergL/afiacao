import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HistoricoTab } from '../HistoricoTab';
import type { PedidoRow } from '../types';

const row: PedidoRow = {
  id: 88, empresa: 'OBEN', fornecedor_nome: 'SAYERLACK', data_ciclo: '2026-01-10',
  num_skus: 4, valor_total: 800, status: 'disparado', status_envio_portal: 'sucesso_portal',
  aprovado_em: '2026-01-10T10:00:00', enviado_portal_em: '2026-01-10T11:00:00', portal_tentativas: 1,
  portal_proximo_retry_em: null, portal_protocolo: 'PROTO-9', portal_screenshot_url: null, portal_erro: null,
};

function noop() { /* */ }
const renderTab = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

const baseProps = {
  histStatus: 'todos' as const, setHistStatus: noop,
  histRange: '30' as const, setHistRange: noop,
  histBusca: '', setHistBusca: noop, onOpenDrawer: noop,
};

describe('HistoricoTab', () => {
  it('vazio → mensagem de período', () => {
    renderTab(<HistoricoTab loading={false} rows={[]} {...baseProps} />);
    expect(screen.getByText('Sem registros no período.')).toBeTruthy();
  });

  it('com registro → ID, protocolo e Ver detalhes dispara onOpenDrawer', () => {
    const onOpenDrawer = vi.fn();
    renderTab(<HistoricoTab loading={false} rows={[row]} {...baseProps} onOpenDrawer={onOpenDrawer} />);
    expect(screen.getByText('#88')).toBeTruthy();
    expect(screen.getByText('PROTO-9')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }));
    expect(onOpenDrawer).toHaveBeenCalledWith(88);
  });
});
