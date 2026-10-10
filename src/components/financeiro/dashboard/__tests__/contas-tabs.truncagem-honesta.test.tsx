import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ContasPagarTab } from '../ContasPagarTab';
import { ContasReceberTab } from '../ContasReceberTab';
import type { FinContaPagar, FinContaReceber } from '@/services/financeiroService';
import { BAIXA_OMIE_LIST } from '@/lib/financeiro/procedencia-baixa';
import type { TotaisContas } from '@/lib/financeiro/totais-contas';

// Truncagem HONESTA (money-path §8/§10): a lista da tela vem com `limit`, e o count EXATO do
// mesmo filtro diz se é tudo. Antes a aba mostrava "500 títulos" e somava os 500 nos
// totalizadores como se fossem o filtro — e o CSV exportava o mesmo corte.

const { getContasPagar, getContasReceber, downloadCSV, toastError } = vi.hoisted(() => ({
  getContasPagar: vi.fn(),
  getContasReceber: vi.fn(),
  downloadCSV: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/services/financeiroService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/financeiroService')>();
  return { ...real, getContasPagar, getContasReceber, downloadCSV };
});
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

const cp: FinContaPagar = {
  id: 'cp-1', company: 'oben', omie_codigo_lancamento: 1, nome_fornecedor: 'Fornecedor Beta',
  cnpj_cpf: '12345678000190', numero_documento: 'NF-200', data_emissao: '2026-01-01',
  data_vencimento: '2026-02-01', data_pagamento: null, valor_documento: 2000, valor_pago: 0,
  saldo: 2000, status_titulo: 'ABERTO', categoria_codigo: '2.01', categoria_descricao: 'Insumos',
  tipo_documento: null, observacao: null,
};
const cr = {
  ...cp, id: 'cr-1', nome_cliente: 'Cliente Alfa', valor_recebido: 0, data_recebimento: null,
} as unknown as FinContaReceber;

const totals: TotaisContas = { valor: 2000, baixa: null, saldo: null, procedencia: BAIXA_OMIE_LIST };
const noop = () => { /* */ };

function renderCP(cpTotal: number | null) {
  return render(
    <ContasPagarTab
      cpFilter="ABERTO" setCpFilter={noop} cpDateFrom="2026-01-01" setCpDateFrom={noop}
      cpDateTo="" setCpDateTo={noop} contasPagar={[cp]} cpTotal={cpTotal} cpTotals={totals}
      view="oben" loading={false} onAudit={noop}
    />,
  );
}
function renderCR(crTotal: number | null) {
  return render(
    <ContasReceberTab
      crFilter="ABERTO" setCrFilter={noop} crDateFrom="" setCrDateFrom={noop}
      crDateTo="" setCrDateTo={noop} contasReceber={[cr]} crTotal={crTotal} crTotals={totals}
      view="oben" loading={false} onAudit={noop}
    />,
  );
}

beforeEach(() => {
  getContasPagar.mockReset();
  getContasReceber.mockReset();
  downloadCSV.mockReset();
  toastError.mockReset();
});

describe('abas de contas — truncagem honesta', () => {
  it('CP truncada: badge "N de TOTAL", aviso e totalizador rotulado como só-exibidos', () => {
    renderCP(11_000);
    expect(screen.getByText('1 de 11000 títulos')).toBeTruthy();
    expect(screen.getByText(/Mostrando os primeiros 1 de 11000 títulos do filtro/)).toBeTruthy();
    expect(screen.getByText('Valor Total (exibidos)')).toBeTruthy();
  });

  it('CP completa (total == exibidos): nenhum aviso, rótulo normal — o aviso não é ruído permanente', () => {
    renderCP(1);
    expect(screen.getByText('1 títulos')).toBeTruthy();
    expect(screen.queryByText(/Mostrando os primeiros/)).toBeNull();
    expect(screen.getByText('Valor Total')).toBeTruthy();
  });

  it('CR truncada: mesmo contrato na aba gêmea', () => {
    renderCR(43_000);
    expect(screen.getByText('1 de 43000 títulos')).toBeTruthy();
    expect(screen.getByText(/Mostrando os primeiros 1 de 43000 títulos do filtro/)).toBeTruthy();
  });

  it('CSV exporta o FILTRO INTEIRO (busca sem limit no clique), não o corte da tela', async () => {
    const todas = [cp, { ...cp, id: 'cp-2' }, { ...cp, id: 'cp-3' }];
    getContasPagar.mockResolvedValue({ rows: todas, total: 3 });
    renderCP(3);
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(downloadCSV).toHaveBeenCalledTimes(1));
    // mesmo filtro da tela, SEM `limit`
    expect(getContasPagar).toHaveBeenCalledWith('oben', { status: 'ABERTO', dataInicio: '2026-01-01' });
    const csv = downloadCSV.mock.calls[0][0] as string;
    expect(csv.split('\n').filter((l) => l.includes('Fornecedor Beta'))).toHaveLength(3);
  });

  it('CSV com falha de leitura NÃO baixa arquivo parcial/vazio — avisa o erro', async () => {
    getContasPagar.mockRejectedValue(new Error('timeout 57014'));
    renderCP(3);
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(String(toastError.mock.calls[0][0])).toContain('Falha ao exportar CSV');
    expect(downloadCSV).not.toHaveBeenCalled();
  });
});
