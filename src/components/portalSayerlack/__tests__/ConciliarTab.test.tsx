import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConciliarTab } from '../ConciliarTab';
import type { PedidoRow } from '../types';

const row: PedidoRow = {
  id: 55, empresa: 'OBEN', fornecedor_nome: 'SAYERLACK', data_ciclo: '2026-01-10',
  num_skus: 3, valor_total: 500, status: 'disparado', status_envio_portal: 'aceito_portal_sem_protocolo',
  aprovado_em: '2026-01-10T10:00:00', enviado_portal_em: null, portal_tentativas: 2,
  portal_proximo_retry_em: null, portal_protocolo: null, portal_screenshot_url: null,
  portal_erro: 'sem protocolo retornado',
};

function noop() { /* */ }
const renderTab = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('ConciliarTab', () => {
  it('mostra o aviso de conciliação manual sempre', () => {
    renderTab(<ConciliarTab loading={false} rows={[]} busca="" setBusca={noop} onOpenDrawer={noop} />);
    expect(screen.getByText(/Conciliação manual:/)).toBeTruthy();
    expect(screen.getByText('Nenhum pedido aguardando conciliação.')).toBeTruthy();
  });

  it('com pedido → ID, motivo e botão Conciliar dispara onOpenDrawer', () => {
    const onOpenDrawer = vi.fn();
    renderTab(<ConciliarTab loading={false} rows={[row]} busca="" setBusca={noop} onOpenDrawer={onOpenDrawer} />);
    expect(screen.getByText('#55')).toBeTruthy();
    expect(screen.getByText('sem protocolo retornado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Conciliar' }));
    expect(onOpenDrawer).toHaveBeenCalledWith(55);
  });
});
