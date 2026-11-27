import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';

// PR 8.2: sem cadastro confirmado o envio do staff trava — a única saída é "Trocar" (como no 8.1).
const cliente = { codigo_cliente: 1, razao_social: 'Metalúrgica A', nome_fantasia: 'Metalúrgica A', cnpj_cpf: '01' } as unknown as OmieCustomer;

function montar(extra: Partial<React.ComponentProps<typeof CustomerSearch>>) {
  render(
    <CustomerSearch
      selectedCustomer={cliente} customerUserId={null} customerSearch="" onSearchChange={vi.fn()}
      customers={[]} searchingCustomers={false} loadingCustomer={false}
      validatingVendedor={false} vendedorDivergencias={[]} estadoVendedor="consistente"
      onSelectCustomer={vi.fn()} onClearCustomer={vi.fn()} itensNoCarrinho={3}
      {...extra}
    />,
  );
}

describe('CustomerSearch — cadastro do cliente (PR 8.2)', () => {
  // A ÚNICA saída é "Trocar" (seleção nova). Nada de criar daqui (Codex r1) nem revalidar mantendo o
  // carrinho (Codex r2: 4 P0 — prazo, preço provisório, código/vendedor antigos, autocadastro em dobro).
  it.each([
    ['indisponivel', 'cadastro-indisponivel', 'Não foi possível identificar o cliente no app'],
    ['sem_cadastro', 'cadastro-ausente', 'Cliente sem cadastro no app'],
  ] as const)('%s: avisa, manda "Trocar" e NÃO oferece revalidar nem criar', (estado, testid, titulo) => {
    montar({ estadoCadastro: estado });
    const aviso = screen.getByTestId(testid).textContent ?? '';
    expect(aviso).toContain(titulo);
    expect(aviso).toContain('Trocar');
    expect(aviso).toContain('nome do vendedor');
    expect(screen.queryByRole('button', { name: /Revalidar|Tentar de novo|Criar/ })).toBeNull();
  });

  it('busca falhou: o cartão NÃO afirma "Sem cadastro no app" (Codex r1 P2)', () => {
    montar({ estadoCadastro: 'indisponivel' });
    expect(screen.queryByText('Sem cadastro no app')).toBeNull();
  });

  // Codex r3/r4: com envio pendente, "Trocar" zera o checkoutId → um novo envio pode criar 2º PV.
  it.each([
    ['indisponivel', 'cadastro-indisponivel'],
    ['sem_cadastro', 'cadastro-ausente'],
  ] as const)('%s com envio pendente: NÃO manda "use Trocar", manda recarregar', (estado, testid) => {
    montar({ estadoCadastro: estado, envioPendente: true });
    const aviso = screen.getByTestId(testid).textContent ?? '';
    expect(aviso).toContain('NÃO use “Trocar”');
    expect(aviso).toContain('recarregue a página');
  });

  it('com envio pendente, o diálogo do Trocar avisa do pedido em dobro (mesmo de carrinho vazio)', () => {
    montar({ estadoCadastro: 'indisponivel', envioPendente: true, itensNoCarrinho: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar cliente' }));
    expect(screen.getByTestId('troca-envio-pendente').textContent).toContain('pedido em dobro');
  });

  it('sem envio pendente, o diálogo não traz o aviso', () => {
    montar({ estadoCadastro: 'indisponivel' });
    fireEvent.click(screen.getByRole('button', { name: 'Trocar cliente' }));
    expect(screen.queryByTestId('troca-envio-pendente')).toBeNull();
  });

  it('confirmado: nenhum aviso de cadastro', () => {
    montar({ estadoCadastro: 'confirmado' });
    expect(screen.queryByTestId('cadastro-indisponivel')).toBeNull();
    expect(screen.queryByTestId('cadastro-ausente')).toBeNull();
  });
});
