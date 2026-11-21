import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrderSuccessDialog } from '../OrderSuccessDialog';

// A6 (rodada 2): pendência de ERP abria o resumo com título de SUCESSO (só o bloqueio de crédito
// mudava o título) — a vendedora fechava achando que o pedido estava no Omie.
function abrir(envioConfirmado: boolean) {
  render(
    <OrderSuccessDialog
      open onOpenChange={vi.fn()} customerName="ACME" items={[]} total={0}
      orderNumbers={['PV Oben (pendente ERP)']} onViewOrder={vi.fn()} onShare={vi.fn()}
      envioConfirmado={envioConfirmado}
    />,
  );
}

describe('OrderSuccessDialog — título pelo desfecho real (A6)', () => {
  it('envio NÃO confirmado → "pendente no ERP", nunca "sucesso"', () => {
    abrir(false);
    expect(screen.getByText('Pedido salvo — pendente no ERP')).toBeTruthy();
    expect(screen.queryByText('Pedido criado com sucesso!')).toBeNull();
  });

  it('envio confirmado → sucesso', () => {
    abrir(true);
    expect(screen.getByText('Pedido criado com sucesso!')).toBeTruthy();
  });
});

// B4 (rodada 2): serviço "a orçar" aparecia como R$ 0,00 e o total como se fosse o do pedido.
describe('OrderSuccessDialog — a orçar (B4)', () => {
  it('item sem preço sai "A orçar" e o total vira "Subtotal conhecido" com o aviso', () => {
    render(
      <OrderSuccessDialog
        open onOpenChange={vi.fn()} customerName="ACME"
        items={[{ description: 'Lixa', quantity: 2, unitPrice: 10 }, { description: 'Afiação serra', quantity: 1, unitPrice: null }]}
        total={20} itensAOrcar={1}
        orderNumbers={['PV 1']} onViewOrder={vi.fn()} onShare={vi.fn()} envioConfirmado
      />,
    );
    expect(screen.getByText('A orçar')).toBeTruthy();
    expect(screen.queryByText(/R\$\s0,00/)).toBeNull();
    expect(screen.getByText('Subtotal conhecido')).toBeTruthy();
    expect(screen.queryByText('Total')).toBeNull();
    expect(screen.getByText(/Total a definir: 1 item a orçar/)).toBeTruthy();
  });

  it('sem item a orçar: "Total" de sempre', () => {
    render(
      <OrderSuccessDialog
        open onOpenChange={vi.fn()} customerName="ACME"
        items={[{ description: 'Lixa', quantity: 2, unitPrice: 10 }]} total={20}
        orderNumbers={['PV 1']} onViewOrder={vi.fn()} onShare={vi.fn()} envioConfirmado
      />,
    );
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.queryByText('Subtotal conhecido')).toBeNull();
  });
});
