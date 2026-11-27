import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';

// PR 8.2: sem cadastro confirmado o envio do staff trava — a saída é "Revalidar cadastro" (refaz a seleção), sem limpar o carrinho.
const cliente = { codigo_cliente: 1, razao_social: 'Metalúrgica A', nome_fantasia: 'Metalúrgica A', cnpj_cpf: '01' } as unknown as OmieCustomer;

function montar(extra: Partial<React.ComponentProps<typeof CustomerSearch>>) {
  const onClearCustomer = vi.fn();
  render(
    <CustomerSearch
      selectedCustomer={cliente} customerUserId={null} customerSearch="" onSearchChange={vi.fn()}
      customers={[]} searchingCustomers={false} loadingCustomer={false}
      validatingVendedor={false} vendedorDivergencias={[]} estadoVendedor="consistente"
      onSelectCustomer={vi.fn()} onClearCustomer={onClearCustomer} itensNoCarrinho={3}
      {...extra}
    />,
  );
  return { onClearCustomer };
}

describe('CustomerSearch — cadastro do cliente (PR 8.2)', () => {
  it('busca falhou: aviso + "Revalidar cadastro", sem limpar o carrinho', () => {
    const onRevalidarCadastro = vi.fn();
    const { onClearCustomer } = montar({ estadoCadastro: 'indisponivel', onRevalidarCadastro });
    expect(screen.getByTestId('cadastro-indisponivel').textContent).toContain('Não foi possível identificar o cliente no app');
    fireEvent.click(screen.getByRole('button', { name: 'Revalidar cadastro' }));
    expect(onRevalidarCadastro).toHaveBeenCalledTimes(1);
    expect(onClearCustomer).not.toHaveBeenCalled();
  });

  it('sem cadastro: aviso + "Revalidar cadastro" e NADA de criar daqui (Codex r1: 4 P0 na criação)', () => {
    const onRevalidarCadastro = vi.fn();
    const { onClearCustomer } = montar({ estadoCadastro: 'sem_cadastro', onRevalidarCadastro });
    expect(screen.getByTestId('cadastro-ausente').textContent).toContain('Cliente sem cadastro no app');
    expect(screen.queryByRole('button', { name: /Criar/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revalidar cadastro' }));
    expect(onRevalidarCadastro).toHaveBeenCalledTimes(1);
    expect(onClearCustomer).not.toHaveBeenCalled();
  });

  it('busca falhou: o cartão NÃO afirma "Sem cadastro no app" (Codex r1 P2)', () => {
    montar({ estadoCadastro: 'indisponivel', onRevalidarCadastro: vi.fn() });
    expect(screen.queryByText('Sem cadastro no app')).toBeNull();
  });

  it('confirmado: nenhum aviso de cadastro', () => {
    montar({ estadoCadastro: 'confirmado', onRevalidarCadastro: vi.fn() });
    expect(screen.queryByTestId('cadastro-indisponivel')).toBeNull();
    expect(screen.queryByTestId('cadastro-ausente')).toBeNull();
  });
});
