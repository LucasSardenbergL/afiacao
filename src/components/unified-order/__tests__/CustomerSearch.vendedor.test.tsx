import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';

// PR 8.1: divergência (com ou sem lista) bloqueia o envio e AVISA — com lista vazia nem aviso havia (r2 do Codex).
// SEM "Revalidar" (r3, 2 P0): revalidar não recarrega os códigos de vendedor da seleção e uma conta que falha
// some da comparação na edge. r4 (P0; founder: só Trocar): idem no 'indisponivel'. A saída é "Trocar".
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
  it('divergente SEM lista mostra o aviso, manda trocar e NÃO oferece revalidar', () => {
    montar({ estadoVendedor: 'divergente' });
    const aviso = screen.getByTestId('vendedor-divergente').textContent ?? '';
    expect(aviso).toContain('sem detalhar as contas');
    expect(aviso).toContain('Trocar');
    expect(screen.queryByRole('button', { name: /Revalidar|Tentar de novo/ })).toBeNull();
  });

  it('divergente COM lista mostra as contas e NÃO oferece revalidar', () => {
    montar({ estadoVendedor: 'divergente', vendedorDivergencias: ['Oben: vendedor B'] });
    expect(screen.getByTestId('vendedor-divergente').textContent).toContain('Oben: vendedor B');
    expect(screen.queryByRole('button', { name: /Revalidar|Tentar de novo/ })).toBeNull();
  });

  it('indisponivel avisa, manda trocar e NÃO oferece tentar de novo', () => {
    montar({ estadoVendedor: 'indisponivel' });
    const aviso = screen.getByRole('alert').textContent ?? '';
    expect(aviso).toContain('Não foi possível validar o vendedor');
    expect(aviso).toContain('Trocar');
    expect(screen.queryByRole('button', { name: /Revalidar|Tentar de novo/ })).toBeNull();
  });

  it('consistente não mostra aviso de divergência', () => {
    montar({ estadoVendedor: 'consistente' });
    expect(screen.queryByTestId('vendedor-divergente')).toBeNull();
  });
});
