import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';

// PR 8.2: sem cadastro confirmado o envio do staff trava — com saída que NÃO limpa o carrinho.
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

  it('sem cadastro: aviso + "Criar cadastro no app"; desabilita enquanto cria', () => {
    const onCriarCadastro = vi.fn();
    montar({ estadoCadastro: 'sem_cadastro', onCriarCadastro });
    expect(screen.getByTestId('cadastro-ausente').textContent).toContain('Cliente sem cadastro no app');
    fireEvent.click(screen.getByRole('button', { name: 'Criar cadastro no app' }));
    expect(onCriarCadastro).toHaveBeenCalledTimes(1);
  });

  it('criando: botão desabilitado (sem clique duplo)', () => {
    montar({ estadoCadastro: 'sem_cadastro', onCriarCadastro: vi.fn(), criandoCadastro: true });
    expect((screen.getByRole('button', { name: 'Criando…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('confirmado: nenhum aviso de cadastro', () => {
    montar({ estadoCadastro: 'confirmado', onRevalidarCadastro: vi.fn(), onCriarCadastro: vi.fn() });
    expect(screen.queryByTestId('cadastro-indisponivel')).toBeNull();
    expect(screen.queryByTestId('cadastro-ausente')).toBeNull();
  });
});
