import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';

// PR 8.1, r2 do Codex: divergência (com ou sem lista) bloqueia o envio — precisa de saída que NÃO descarte
// o carrinho (antes só "Trocar"). Com lista vazia nem aviso havia: o envio travava sem explicação.
const cliente = { codigo_cliente: 1, razao_social: 'Metalúrgica A', nome_fantasia: 'Metalúrgica A', cnpj_cpf: '01' } as unknown as OmieCustomer;

function montar(extra: Partial<React.ComponentProps<typeof CustomerSearch>>) {
  render(
    <CustomerSearch
      selectedCustomer={cliente} customerUserId={null} customerSearch="" onSearchChange={vi.fn()}
      customers={[]} searchingCustomers={false} loadingCustomer={false}
      validatingVendedor={false} vendedorDivergencias={[]}
      onSelectCustomer={vi.fn()} onClearCustomer={vi.fn()}
      {...extra}
    />,
  );
}

describe('CustomerSearch — vendedor divergente (PR 8.1)', () => {
  it('divergente SEM lista mostra o aviso e "Revalidar"', () => {
    const onRevalidarVendedor = vi.fn();
    montar({ estadoVendedor: 'divergente', onRevalidarVendedor });
    expect(screen.getByTestId('vendedor-divergente').textContent).toContain('sem detalhar as contas');
    fireEvent.click(screen.getByRole('button', { name: 'Revalidar' }));
    expect(onRevalidarVendedor).toHaveBeenCalledTimes(1);
  });

  it('divergente COM lista mostra as contas e "Revalidar"', () => {
    const onRevalidarVendedor = vi.fn();
    montar({ estadoVendedor: 'divergente', vendedorDivergencias: ['Oben: vendedor B'], onRevalidarVendedor });
    expect(screen.getByTestId('vendedor-divergente').textContent).toContain('Oben: vendedor B');
    fireEvent.click(screen.getByRole('button', { name: 'Revalidar' }));
    expect(onRevalidarVendedor).toHaveBeenCalledTimes(1);
  });

  it('consistente não mostra aviso de divergência', () => {
    montar({ estadoVendedor: 'consistente', onRevalidarVendedor: vi.fn() });
    expect(screen.queryByTestId('vendedor-divergente')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revalidar' })).toBeNull();
  });
});
