import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { VendaAssistidaSelo } from '../VendaAssistidaSelo';
import { resolverOpcaoVenda } from '@/lib/venda-assistida/resolver-opcao';

afterEach(cleanup);

describe('VendaAssistidaSelo', () => {
  it('em estoque + preço → mostra R$/L e "Em estoque" (teórico)', () => {
    const opcao = resolverOpcaoVenda({
      temSkuConfirmado: true,
      temCatalisador: false,
      proporcaoPct: null,
      baseEmbalagens: [{ valor: 360, litros: 3.6, estoque: 5 }],
      catalisadorEmbalagens: [],
    });
    render(<VendaAssistidaSelo option={opcao} />);
    expect(screen.getByText('Em estoque')).toBeTruthy();
    expect(screen.getByText(/\/L/)).toBeTruthy(); // "R$ 100,00/L"
    expect(screen.getByText('(teórico)')).toBeTruthy();
  });

  it('catalisador obrigatório sem casamento → "sob consulta", "Encomenda", sem (teórico)', () => {
    const opcao = resolverOpcaoVenda({
      temSkuConfirmado: true,
      temCatalisador: true,
      proporcaoPct: 10,
      baseEmbalagens: [{ valor: 360, litros: 3.6, estoque: 5 }],
      catalisadorEmbalagens: [], // catalisador obrigatório sem casamento → incomplete
    });
    render(<VendaAssistidaSelo option={opcao} />);
    expect(screen.getByText('sob consulta')).toBeTruthy();
    expect(screen.getByText('Encomenda')).toBeTruthy();
    expect(screen.queryByText('(teórico)')).toBeNull();
  });
});
