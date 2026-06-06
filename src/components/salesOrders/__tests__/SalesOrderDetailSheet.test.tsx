import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SalesOrderDetailSheet } from '../SalesOrderDetailSheet';
import type { SalesOrder } from '../types';

function order(p: Partial<SalesOrder> = {}): SalesOrder {
  return {
    id: 'o1',
    customer_user_id: 'u1',
    items: [
      // Base com tinta + valor_total zerado (caso do rascunho da foto)
      { descricao: 'BASE PU ACRI FOSCO', quantidade: 2, valor_unitario: 50, valor_total: 0, tint_cor_id: '1247', tint_nome_cor: 'AZUL RAL 5010' },
      { descricao: 'CATALISADOR FC', quantidade: 2, valor_unitario: 40, valor_total: 80 },
    ],
    subtotal: 180,
    total: 180,
    status: 'rascunho',
    omie_numero_pedido: '0011326',
    omie_pedido_id: null,
    created_at: '2026-06-02T21:00:00Z',
    notes: null,
    account: 'oben',
    _source: 'sales',
    ...p,
  } as SalesOrder;
}

function setup(o: SalesOrder | null) {
  render(
    <SalesOrderDetailSheet
      order={o}
      customerName="DELTA INTERIORES"
      onClose={vi.fn()}
      onPrint={vi.fn()}
      onShare={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

describe('SalesOrderDetailSheet', () => {
  it('mostra a cor da base (código - nome) quando o item tem tinta', () => {
    setup(order());
    expect(screen.getByText(/🎨\s*1247\s*-\s*AZUL RAL 5010/)).toBeTruthy();
  });

  it('item sem tinta não mostra linha de cor', () => {
    setup(order({ items: [{ descricao: 'CATALISADOR', quantidade: 1, valor_unitario: 40, valor_total: 40 }] }));
    expect(screen.queryByText(/🎨/)).toBeNull();
  });

  it('exibe o total do item calculado (qtd × unit) quando valor_total vem 0', () => {
    setup(order());
    // base 2 × R$ 50 → total R$ 100,00 (não R$ 0,00)
    expect(screen.getByText(/R\$\s*100,00/)).toBeTruthy();
  });

  it('order null não renderiza conteúdo (painel fechado)', () => {
    setup(null);
    expect(screen.queryByText('DELTA INTERIORES')).toBeNull();
  });
});
