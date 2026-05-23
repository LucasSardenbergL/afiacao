import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContasPagarTab } from '../ContasPagarTab';
import type { FinContaPagar } from '@/services/financeiroService';

const cp: FinContaPagar = {
  id: 'cp-1',
  company: 'colacor',
  omie_codigo_lancamento: 1,
  nome_fornecedor: 'Fornecedor Beta',
  cnpj_cpf: '12345678000190',
  numero_documento: 'NF-200',
  data_emissao: '2026-01-01',
  data_vencimento: '2026-02-01',
  data_pagamento: null,
  valor_documento: 2000,
  valor_pago: 0,
  saldo: 2000,
  status_titulo: 'ABERTO',
  categoria_codigo: '2.01',
  categoria_descricao: 'Insumos',
  tipo_documento: null,
  observacao: null,
};

const totals = { valor: 2000, pago: 0, saldo: 2000 };

function noop() { /* */ }

describe('ContasPagarTab', () => {
  it('lista vazia (não carregando) → mensagem de nenhum título e botões de filtro', () => {
    render(
      <ContasPagarTab
        cpFilter="ABERTO" setCpFilter={noop}
        cpDateFrom="" setCpDateFrom={noop}
        cpDateTo="" setCpDateTo={noop}
        contasPagar={[]} cpTotals={totals}
        view="all" loading={false} onAudit={noop}
      />
    );
    expect(screen.getByText(/Nenhum título encontrado/)).toBeTruthy();
    ['ABERTO', 'VENCIDO', 'PAGO', 'PARCIAL'].forEach(s =>
      expect(screen.getByRole('button', { name: new RegExp(s) })).toBeTruthy()
    );
  });

  it('com título → fornecedor, status e totalizadores', () => {
    render(
      <ContasPagarTab
        cpFilter="ABERTO" setCpFilter={noop}
        cpDateFrom="" setCpDateFrom={noop}
        cpDateTo="" setCpDateTo={noop}
        contasPagar={[cp]} cpTotals={totals}
        view="all" loading={false} onAudit={noop}
      />
    );
    expect(screen.getByText('Fornecedor Beta')).toBeTruthy();
    expect(screen.getByText('NF-200')).toBeTruthy();
    expect(screen.getByText('Insumos')).toBeTruthy();
    expect(screen.getByText('Valor Total')).toBeTruthy();
    expect(screen.getByText('1 títulos')).toBeTruthy();
  });

  it('clicar filtro chama setCpFilter; clicar histórico chama onAudit', () => {
    const setCpFilter = vi.fn();
    const onAudit = vi.fn();
    render(
      <ContasPagarTab
        cpFilter="ABERTO" setCpFilter={setCpFilter}
        cpDateFrom="" setCpDateFrom={noop}
        cpDateTo="" setCpDateTo={noop}
        contasPagar={[cp]} cpTotals={totals}
        view="all" loading={false} onAudit={onAudit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /VENCIDO/ }));
    expect(setCpFilter).toHaveBeenCalledWith('VENCIDO');

    fireEvent.click(screen.getByRole('button', { name: 'Histórico' }));
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'fin_contas_pagar', id: 'cp-1' })
    );
  });
});
