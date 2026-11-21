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
