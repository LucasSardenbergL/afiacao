import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import type { OmieCustomer } from '@/hooks/useUnifiedOrder';

const cliente = (codigo: number, nome: string) =>
  ({ codigo_cliente: codigo, razao_social: nome, nome_fantasia: nome, cnpj_cpf: `0${codigo}` }) as unknown as OmieCustomer;

function montar(customers: OmieCustomer[], extra: Partial<React.ComponentProps<typeof CustomerSearch>> = {}) {
  const onSelectCustomer = vi.fn();
  const onSearchChange = vi.fn();
  render(
    <CustomerSearch
      selectedCustomer={null} customerUserId={null} customerSearch="me" onSearchChange={onSearchChange}
      customers={customers} searchingCustomers={false} loadingCustomer={false}
      validatingVendedor={false} vendedorDivergencias={[]}
      onSelectCustomer={onSelectCustomer} onClearCustomer={vi.fn()}
      {...extra}
    />,
  );
  return { onSelectCustomer, onSearchChange, campo: screen.getByRole('combobox') };
}

describe('CustomerSearch — teclado (combobox)', () => {
  const lista = [cliente(1, 'Metalúrgica A'), cliente(2, 'Marcenaria B'), cliente(3, 'Moveleira C')];

  it('↓↓ + Enter escolhe o 2º resultado', () => {
    const { campo, onSelectCustomer } = montar(lista);
    fireEvent.keyDown(campo, { key: 'ArrowDown' });
    fireEvent.keyDown(campo, { key: 'ArrowDown' });
    expect(campo.getAttribute('aria-activedescendant')).toBeTruthy();
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(campo, { key: 'Enter' });
    expect(onSelectCustomer).toHaveBeenCalledWith(lista[1]);
  });

  it('↑ não passa do 1º e ↓ não passa do último', () => {
    const { campo, onSelectCustomer } = montar(lista);
    for (let i = 0; i < 5; i++) fireEvent.keyDown(campo, { key: 'ArrowDown' });
    fireEvent.keyDown(campo, { key: 'Enter' });
    expect(onSelectCustomer).toHaveBeenLastCalledWith(lista[2]);
    for (let i = 0; i < 5; i++) fireEvent.keyDown(campo, { key: 'ArrowUp' });
    fireEvent.keyDown(campo, { key: 'Enter' });
    expect(onSelectCustomer).toHaveBeenLastCalledWith(lista[0]);
  });

  it('Enter sem destaque NÃO escolhe às cegas quando há vários resultados', () => {
    const { campo, onSelectCustomer } = montar(lista);
    fireEvent.keyDown(campo, { key: 'Enter' });
    expect(onSelectCustomer).not.toHaveBeenCalled();
  });

  it('Enter sem destaque escolhe quando o resultado é único', () => {
    const { campo, onSelectCustomer } = montar([lista[0]]);
    fireEvent.keyDown(campo, { key: 'Enter' });
    expect(onSelectCustomer).toHaveBeenCalledWith(lista[0]);
  });

  it('não escolhe enquanto a busca está em andamento (lista pode ser de outro termo)', () => {
    const { campo, onSelectCustomer } = montar(lista, { searchingCustomers: true });
    fireEvent.keyDown(campo, { key: 'ArrowDown' });
    fireEvent.keyDown(campo, { key: 'Enter' });
    fireEvent.click(screen.getAllByRole('option')[0]);
    expect(onSelectCustomer).not.toHaveBeenCalled();
  });

  it('Esc limpa o termo; clique na opção escolhe', () => {
    const { campo, onSearchChange, onSelectCustomer } = montar(lista);
    fireEvent.keyDown(campo, { key: 'Escape' });
    expect(onSearchChange).toHaveBeenCalledWith('');
    fireEvent.click(screen.getAllByRole('option')[2]);
    expect(onSelectCustomer).toHaveBeenCalledWith(lista[2]);
  });
});
