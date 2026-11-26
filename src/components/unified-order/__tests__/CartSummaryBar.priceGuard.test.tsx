import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type React from 'react';
import { CartSummaryBar } from '../CartSummaryBar';
import { BarraEnvioPedido, type BarraEnvioPedidoProps } from '../BarraEnvioPedido';
import type { ProductCartItem } from '@/hooks/unifiedOrder/types';


// C1/C2 (rodada 2): o Enviar/Orçamento saíram do CartSummaryBar para a BarraEnvioPedido. O
// fechamento é o par renderizado pela página — as mesmas props alimentam os dois.
type PropsFechamento = React.ComponentProps<typeof CartSummaryBar> & Partial<BarraEnvioPedidoProps>;
function Fechamento(p: PropsFechamento) {
  return (
    <>
      <CartSummaryBar {...p} />
      <BarraEnvioPedido
        temCliente carregandoCliente={false} exigeCondicao servicosAOrcar={0}
        submitting={false} vendedorDivergencias={[]} estadoVendedor="nao_verificado" totalEstimated={0} onSubmit={vi.fn()}
        {...p}
      />
    </>
  );
}

function prod(unit_price: number): ProductCartItem {
  return {
    type: 'product', account: 'oben', quantity: 1, unit_price,
    product: { id: 'p', omie_codigo_produto: 'X', codigo: 'C', descricao: 'Lixa', unidade: 'UN' },
  } as unknown as ProductCartItem;
}

function makeProps(obenProductItems: ProductCartItem[]) {
  return {
    cart: { length: obenProductItems.length },
    obenProductItems,
    colacorProductItems: [] as ProductCartItem[],
    serviceItems: [],
    totalEstimated: 100,
    submitting: false,
    vendedorDivergencias: [] as string[],
    estadoVendedor: 'nao_verificado' as const,
    sortedFormasPagamentoOben: [],
    sortedFormasPagamentoColacor: [],
    selectedParcelaOben: '1',
    setSelectedParcelaOben: vi.fn(),
    selectedParcelaColacor: '1',
    setSelectedParcelaColacor: vi.fn(),
    loadingFormas: false,
    customerParcelaRankingOben: [],
    customerParcelaRankingColacor: [],
    notes: '',
    setNotes: vi.fn(),
    volumesOben: 1,
    volumesColacor: 0,
    onSubmit: vi.fn(),
    onSubmitQuote: vi.fn(),
  };
}

describe('CartSummaryBar — guard de preço ≤ 0', () => {
  it('preço positivo → botão Enviar habilitado, sem aviso de preço', () => {
    render(<Fechamento {...makeProps([prod(10)])} />);
    const btn = screen.getByRole('button', { name: /enviar pedido/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.queryByText(/preço maior que zero/i)).toBeNull();
  });

  it('produto com preço 0 → botão Enviar DESABILITADO + aviso visível', () => {
    render(<Fechamento {...makeProps([prod(0)])} />);
    const btn = screen.getByRole('button', { name: /enviar pedido/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/preço maior que zero/i)).toBeTruthy();
  });

  it('produto com preço 0 → botão Orçamento também DESABILITADO', () => {
    render(<Fechamento {...makeProps([prod(0)])} />);
    const btn = screen.getByRole('button', { name: /orçamento/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
