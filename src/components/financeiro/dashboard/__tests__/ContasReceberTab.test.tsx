import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContasReceberTab } from '../ContasReceberTab';
import type { FinContaReceber } from '@/services/financeiroService';
import { BAIXA_OMIE_LIST } from '@/lib/financeiro/procedencia-baixa';
import type { TotaisContas } from '@/lib/financeiro/totais-contas';

const cr: FinContaReceber = {
  id: 'cr-1',
  company: 'colacor',
  omie_codigo_lancamento: 1,
  nome_cliente: 'Cliente Alpha',
  cnpj_cpf: '12345678000190',
  numero_documento: 'NF-100',
  numero_pedido: null,
  data_emissao: '2026-01-01',
  data_vencimento: '2026-02-01',
  data_recebimento: null,
  valor_documento: 1000,
  valor_recebido: 0,
  saldo: 1000,
  status_titulo: 'ABERTO',
  categoria_codigo: '1.01',
  categoria_descricao: 'Vendas',
  vendedor_id: null,
};

// A procedência REAL da tela: `fin_contas_receber` não ingere a baixa (#396), então os
// asserts abaixo são sobre a tela como ela existe hoje. A degradação em si é exercitada em
// `contas-tabs.baixa-indisponivel.test.tsx`, que também cobre o controle de fonte confiável.
const totals: TotaisContas = {
  valor: 1000, baixa: null, saldo: null, procedencia: BAIXA_OMIE_LIST,
};

function noop() { /* */ }

describe('ContasReceberTab', () => {
  it('lista vazia (não carregando) → mensagem de nenhum título e botões de filtro', () => {
    render(
      <ContasReceberTab
        crFilter="ABERTO" setCrFilter={noop}
        crDateFrom="" setCrDateFrom={noop}
        crDateTo="" setCrDateTo={noop}
        contasReceber={[]} crTotals={totals}
        view="all" loading={false} onAudit={noop}
      />
    );
    expect(screen.getByText(/Nenhum título encontrado/)).toBeTruthy();
    ['ABERTO', 'VENCIDO', 'RECEBIDO', 'PARCIAL'].forEach(s =>
      expect(screen.getByRole('button', { name: new RegExp(s) })).toBeTruthy()
    );
  });

  it('com título → cliente, status e totalizadores', () => {
    render(
      <ContasReceberTab
        crFilter="ABERTO" setCrFilter={noop}
        crDateFrom="" setCrDateFrom={noop}
        crDateTo="" setCrDateTo={noop}
        contasReceber={[cr]} crTotals={totals}
        view="all" loading={false} onAudit={noop}
      />
    );
    expect(screen.getByText('Cliente Alpha')).toBeTruthy();
    expect(screen.getByText('NF-100')).toBeTruthy();
    expect(screen.getByText('Vendas')).toBeTruthy();
    expect(screen.getByText('Valor Total')).toBeTruthy();
    expect(screen.getByText('1 títulos')).toBeTruthy();
  });

  it('clicar filtro chama setCrFilter; clicar histórico chama onAudit', () => {
    const setCrFilter = vi.fn();
    const onAudit = vi.fn();
    render(
      <ContasReceberTab
        crFilter="ABERTO" setCrFilter={setCrFilter}
        crDateFrom="" setCrDateFrom={noop}
        crDateTo="" setCrDateTo={noop}
        contasReceber={[cr]} crTotals={totals}
        view="all" loading={false} onAudit={onAudit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /VENCIDO/ }));
    expect(setCrFilter).toHaveBeenCalledWith('VENCIDO');

    fireEvent.click(screen.getByRole('button', { name: 'Histórico' }));
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'fin_contas_receber', id: 'cr-1' })
    );
  });
});
