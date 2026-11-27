import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { rotuloTotal } from '../rotulo-total';
import { BarraEnvioPedido, type BarraEnvioPedidoProps } from '../BarraEnvioPedido';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';

const prod = { type: 'product', account: 'oben', quantity: 1, unit_price: 10,
  product: { id: 'p', omie_codigo_produto: 1, codigo: 'C', descricao: 'Lixa', unidade: 'UN' } } as unknown as ProductCartItem;

function barra(over: Partial<BarraEnvioPedidoProps> = {}) {
  const props: BarraEnvioPedidoProps = {
    temCliente: true, carregandoCliente: false,
    obenProductItems: [prod], colacorProductItems: [], serviceItems: [],
    vendedorDivergencias: [], estadoVendedor: 'nao_verificado', estadoCadastro: 'confirmado', loadingFormas: false, exigeCondicao: true,
    selectedParcelaOben: '999', selectedParcelaColacor: '999',
    submitting: false, totalEstimated: 10, servicosAOrcar: 0, onSubmit: vi.fn(),
    ...over,
  };
  render(<BarraEnvioPedido {...props} />);
  return screen.getByRole('button', { name: /enviar pedido/i }) as HTMLButtonElement;
}

describe('BarraEnvioPedido — motivo do Enviar cinza', () => {
  it('liberado → sem motivo, total visível', () => {
    const btn = barra();
    expect(btn.disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('barra-envio-total').textContent).toMatch(/10,00/);
  });

  it('sem cliente → cinza com "Escolha o cliente" ligado ao botão', () => {
    const btn = barra({ temCliente: false });
    expect(btn.disabled).toBe(true);
    const motivo = screen.getByRole('status');
    expect(motivo.textContent).toContain('Escolha o cliente');
    expect(btn.getAttribute('aria-describedby')).toBe(motivo.id);
  });

  it('carrinho vazio → cinza com "Carrinho vazio"', () => {
    const btn = barra({ obenProductItems: [], totalEstimated: 0 });
    expect(btn.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Carrinho vazio');
    expect(screen.getByTestId('barra-envio-total').textContent).toBe('A definir');
  });

  it('condições carregando → cinza com "Carregando condições…"', () => {
    const btn = barra({ loadingFormas: true });
    expect(btn.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Carregando condições…');
  });

  it('é sticky no fim da tela com safe-area', () => {
    barra();
    const cls = screen.getByTestId('barra-envio-pedido').className;
    expect(cls).toContain('sticky');
    expect(cls).toContain('bottom-0');
    expect(cls).toContain('env(safe-area-inset-bottom)');
  });
});

describe('rotuloTotal — B4 no carrinho e na barra', () => {
  it('serviço a orçar + valor conhecido → Subtotal conhecido', () => {
    expect(rotuloTotal(10, 1).rotulo).toBe('Subtotal conhecido');
  });
  it('sem a orçar → Total; sem valor → A definir', () => {
    expect(rotuloTotal(10, 0).rotulo).toBe('Total');
    expect(rotuloTotal(0, 1)).toEqual({ rotulo: 'Total', valor: 'A definir' });
  });
});
