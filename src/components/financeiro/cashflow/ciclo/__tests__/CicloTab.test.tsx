import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';

const resumoMock = vi.fn();
const coorteMock = vi.fn();
const receitaMock = vi.fn();
const projMock = vi.fn();
const titulosMock = vi.fn();
const custoMock = vi.fn();

vi.mock('@/hooks/useFinanceiroCiclo', () => ({
  hojeSp: () => '2026-10-14',
  useCicloResumo: () => resumoMock(),
  useCicloCoorte: () => coorteMock(),
  useReceitaDiariaTtm: () => receitaMock(),
  useCicloTitulosCliente: () => titulosMock(),
  useCicloGiroSku: () => ({ data: [], isLoading: false, error: null }),
  useRupturaSensor: () => ({ data: { pedidos: [], prateleira: [] }, isLoading: false, error: null }),
  useReguaCiclo: () => ({ data: undefined, isLoading: false, error: null }),
  useCrAbertoTotal: () => ({ data: undefined, isLoading: false, error: null }),
  useCicloCustoCapital: () => custoMock(),
}));
vi.mock('@/hooks/useFinanceiroCompraSuspensa', () => ({
  useCompraSuspensaListar: () => ({ data: [], isLoading: false, error: null, isError: false }),
  useCompraSuspensaRuns: () => ({ data: [], isLoading: false, error: null, isError: false }),
  useCompraSuspensaCandidatos: () => ({ data: [], isLoading: false, error: null, isError: false, isSuccess: true, isFetching: false }),
  useCompraSuspensaMutacoes: () => ({ suspender: { mutate: vi.fn(), isPending: false }, reativar: { mutate: vi.fn(), isPending: false } }),
}));
vi.mock('@/hooks/useFinanceiroCicloFornecedor', () => ({
  useCicloCpTitulos: () => ({ data: [], isLoading: false, error: null }),
  useCicloFornecedorResumo: () => ({ data: [], isLoading: false, error: null }),
  useCicloCpEmpresa: () => ({ data: {}, isLoading: false, error: null }),
}));
vi.mock('@/hooks/useCashflowProjection', () => ({
  useCashflowProjection: (company: string) => projMock(company),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
const ledgerMock = vi.fn();
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: (...a: unknown[]) => ledgerMock(...a) }));

import { CicloTab } from '@/components/financeiro/cashflow/ciclo/CicloTab';
import { montarSerieTendencia, nomeExibido } from '@/components/financeiro/cashflow/ciclo/ciclo-format';

const ok = <T,>(data: T) => ({ data, isLoading: false, error: null });
const cli = (o: Partial<ResumoCliente>): ResumoCliente => ({
  company: 'oben', omieCodigoCliente: 1, nomeCliente: 'ACME', nParcelas: 8, nDocumentos: 8, valorPago: 1000,
  valorPagoSemBaixa: null, prazoConcedidoPond: 30, prazoRealPond: 30, atrasoPond: 0, atrasoP50: 0, atrasoP80: 0,
  atrasoP80Valor: 0, atrasoMaxObservado: 0, excessoCarenciaPond: 0, pctValorAtrasado: 0, ultimaBaixa: '2026-10-01',
  nVencidas: null, saldoVencido: null, saldoVencido90: null, diasVencidoMax: null, volumeEmitido12m: 36500,
  primeiraEmissao: '2025-10-20', nStatusAmbiguo: null, ...o,
});
const proj = { prazo_medio_recebimento: 31, prazo_medio_pagamento: 12, prazo_medio_estoque: 40, cash_conversion_cycle: 59 };

const renderTab = (url = '/') => render(<MemoryRouter initialEntries={[url]}><CicloTab /></MemoryRouter>);

beforeEach(() => {
  coorteMock.mockReturnValue(ok([]));
  receitaMock.mockReturnValue(ok({ oben: { porDia: 11300, mesesComDado: 12 }, colacor: { porDia: 2100, mesesComDado: 9 }, colacor_sc: { porDia: null, mesesComDado: 0 } }));
  titulosMock.mockReturnValue({ data: [], isLoading: false, error: null });
  projMock.mockImplementation(() => ok({ indicadores: proj, confianca_dados: { motivos: [] } }));
  // CET do banco (PR3): oben cadastrada (2,5% a.m.), colacor/colacor_sc sem CET.
  custoMock.mockReturnValue(ok([
    { company: 'oben', custoMensal: 0.025, fonte: 'founder 2026-10-31', em: '2026-10-31T18:00:00Z' },
    { company: 'colacor', custoMensal: null, fonte: null, em: null },
    { company: 'colacor_sc', custoMensal: null, fonte: null, em: null },
  ]));
});

describe('CicloTab', () => {
  it('abrir a aba registra financeiro.ciclo_aberto no ledger (chave fixa: 1 por titular/dia)', () => {
    ledgerMock.mockClear();
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(ledgerMock).toHaveBeenCalledTimes(1);
    expect(ledgerMock).toHaveBeenCalledWith('financeiro.ciclo_aberto', 'aba');
  });

  it('erro de leitura do resumo mostra erro, não estado vazio', () => {
    resumoMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    renderTab();
    expect(screen.getByText(/não foi possível ler/i)).toBeInTheDocument();
    expect(screen.queryByText(/sem títulos/i)).not.toBeInTheDocument();
  });

  it('PME ausente mostra — e o motivo, nunca 0d; fonte do estoque aparece', () => {
    resumoMock.mockReturnValue(ok([]));
    projMock.mockImplementation((company: string) => ok({
      indicadores: { ...proj, prazo_medio_estoque: company === 'oben' ? null : 40, cash_conversion_cycle: company === 'oben' ? null : 59,
        estoque_valor: 445476, estoque_fonte: company === 'oben' ? 'omie' : 'manual', estoque_data_ref: '2026-10-01' },
      confianca_dados: { motivos: company === 'oben' ? ['CMV do DRE cobre 6/12 meses fechados (último: 2026-03) — PME indisponível.'] : [] },
    }));
    renderTab('/?cicloEmpresa=all');
    const card = screen.getByTestId('ciclo-card-oben');
    expect(within(card).queryByText('0d')).not.toBeInTheDocument();
    expect(within(card).getByText(/6\/12 meses fechados/)).toBeInTheDocument();
    expect(within(card).getByTestId('ciclo-estoque-oben').textContent).toMatch(/Omie, agora/);
    expect(within(screen.getByTestId('ciclo-card-colacor')).getByTestId('ciclo-estoque-colacor').textContent).toMatch(/manual, 01\/10/);
  });

  it('sucesso vazio mostra EmptyState', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(screen.getByText(/sem títulos/i)).toBeInTheDocument();
  });

  it('mesmo nome em 2 empresas renderiza 2 linhas (chave composta)', () => {
    resumoMock.mockReturnValue(ok([cli({ company: 'oben' }), cli({ company: 'colacor' })]));
    renderTab('/?cicloEmpresa=all');
    expect(screen.getAllByText('ACME')).toHaveLength(2);
  });

  it('cliente só-vencido aparece como estoque vencido a recuperar', () => {
    resumoMock.mockReturnValue(ok([cli({ nParcelas: null, nDocumentos: null, atrasoP80: null, atrasoP80Valor: null, ultimaBaixa: null, saldoVencido: 500 })]));
    renderTab();
    expect(screen.getByText(/R\$\s*500 vencidos/)).toBeInTheDocument();
    expect(screen.getByText(/estoque vencido a recuperar/)).toBeInTheDocument();
  });

  it('degrau_prazo sem degrau (parcelado): mostra texto e motivo, sem R$ no cenário', () => {
    resumoMock.mockReturnValue(ok([cli({ nParcelas: 16, nDocumentos: 8 })]));
    renderTab();
    expect(screen.getByText(/Parcelado/)).toBeInTheDocument();
    expect(screen.getByText(/parcelado: média não é condição/)).toBeInTheDocument();
    expect(screen.getByText(/não é previsão/)).toBeInTheDocument();
  });

  it('cenário com R$ vem sempre com o rótulo "não é previsão"', () => {
    resumoMock.mockReturnValue(ok([cli({ prazoConcedidoPond: 60 })]));
    renderTab();
    expect(screen.getByText(/R\$\s*[\d.]+/, { selector: 'div.font-mono' })).toBeInTheDocument();
    expect(screen.getByText(/não é previsão/)).toBeInTheDocument();
  });

  it('engine falha numa empresa: só ela vira "—", as outras seguem', () => {
    resumoMock.mockReturnValue(ok([]));
    projMock.mockImplementation((c: string) =>
      c === 'colacor' ? { data: undefined, isLoading: false, error: new Error('500') } : ok({ indicadores: proj, confianca_dados: { motivos: [] } }));
    renderTab();
    expect(screen.getByTestId('ciclo-card-colacor')).toHaveTextContent('—');
    expect(screen.getByTestId('ciclo-card-oben')).toHaveTextContent('31d');
  });

  it('receita TTM ausente aparece como "—", nunca R$ 0', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(screen.getByTestId('ciclo-card-colacor_sc')).toHaveTextContent('— (sem receita TTM)');
    expect(screen.getByTestId('ciclo-card-colacor_sc')).not.toHaveTextContent('R$');
  });

  it('mostra o caveat fixo', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(screen.getByText(/Todo R\$ é cenário, não previsão/)).toBeInTheDocument();
  });

  it('CET vem do banco: oben (2,5% a.m.) calcula o desconto máximo; a URL não manda mais', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab('/?cicloCustoOben=35');
    expect(screen.getByTestId('ciclo-desconto-oben')).toHaveTextContent('2,5% a.m.');
    expect(screen.getByTestId('ciclo-desconto-oben')).toHaveTextContent('30 dias');
    expect(screen.getByTestId('ciclo-desconto-oben')).toHaveTextContent('fonte: founder 2026-10-31');
    expect(screen.queryByRole('textbox', { name: /custo/i })).not.toBeInTheDocument();
  });

  it('alerta fixo: 1% por 7 dias ≈ 68,9% a.a.', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(screen.getByTestId('ciclo-desconto-alerta-anual')).toHaveTextContent('68,9% a.a.');
  });

  it('erro de leitura do CET: sem número e com o motivo (nunca 0)', () => {
    resumoMock.mockReturnValue(ok([]));
    custoMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    renderTab();
    expect(screen.getByText(/Não foi possível ler o custo do dinheiro/)).toBeInTheDocument();
    expect(screen.queryByTestId('ciclo-desconto-oben')).not.toBeInTheDocument();
  });

  it('tendência marca os meses parciais (rótulo com "*" e flag), sem preencher ausente', () => {
    const m = (mes: string, mesParcial: boolean, prazoReal: number | null) => ({
      company: 'oben' as const, mes, valorVencido: 1, valorPago: 1, valorEmAberto: 0, pctValorPago: null,
      prazoConcedido: 30, prazoReal, atraso: null, mesParcial,
    });
    const serie = montarSerieTendencia([m('2025-10-01', true, 33), m('2025-11-01', false, null), m('2026-10-01', true, 31)], 'oben');
    expect(serie.map((p) => p.mes)).toEqual(['2025-10*', '2025-11', '2026-10*']);
    expect(serie.map((p) => p.parcial)).toEqual([true, false, true]);
    expect(serie[1].real).toBeNull();
    expect(serie[1].pago).toBeNull();
  });

  it('drill: NF ausente vira "—" e todas as situações têm rótulo legível', () => {
    resumoMock.mockReturnValue(ok([cli({})]));
    const t = (lancamento: number, situacao: string, documento: string | null) => ({
      lancamento, documento, emissao: '2026-01-01', vencimento: '2026-02-01', baixa: null, valor: 100, saldo: 100,
      situacao, prazoConcedido: 30, prazoReal: null, atraso: null, diasVencido: situacao === 'vencida_aberta' ? 12 : null,
    });
    titulosMock.mockReturnValue(ok([
      t(1, 'paga', null), t(2, 'paga_sem_baixa', 'NF-2'), t(3, 'vencida_aberta', 'NF-3'), t(4, 'status_ambiguo', 'NF-4'),
    ]));
    renderTab();
    fireEvent.click(screen.getByText('ACME'));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText('Paga (sem data de baixa)')).toBeInTheDocument();
    expect(within(dlg).getByText(/Vencida em aberto há 12d/)).toBeInTheDocument();
    expect(within(dlg).getByText('Status ambíguo')).toBeInTheDocument();
    const linha1 = within(dlg).getByText('Paga').closest('tr') as HTMLElement;
    expect(within(linha1).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('drill: degrau mostra "45d → 42d" sem calendário inventado', () => {
    resumoMock.mockReturnValue(ok([cli({ prazoConcedidoPond: 45 })]));
    renderTab();
    fireEvent.click(screen.getByText('ACME'));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText(/45d → 42d/)).toBeInTheDocument();
    expect(dlg).not.toHaveTextContent('84');
  });

  it('drill: parcelado sem degrau mostra texto e motivo do helper', () => {
    resumoMock.mockReturnValue(ok([cli({ nParcelas: 16, nDocumentos: 8 })]));
    renderTab();
    fireEvent.click(screen.getByText('ACME'));
    expect(within(screen.getByRole('dialog')).getByText(/Sem degrau numérico: parcelado: média não é condição/)).toBeInTheDocument();
  });

  it('drill: vencida_aberta sem saldo mostra valor original com indicação', () => {
    resumoMock.mockReturnValue(ok([cli({})]));
    titulosMock.mockReturnValue(ok([{
      lancamento: 9, documento: null, emissao: '2026-01-01', vencimento: '2026-02-01', baixa: null, valor: 100, saldo: null,
      situacao: 'vencida_aberta', prazoConcedido: 30, prazoReal: null, atraso: null, diasVencido: 5,
    }]));
    renderTab();
    fireEvent.click(screen.getByText('ACME'));
    expect(within(screen.getByRole('dialog')).getByText(/valor original; saldo ausente/)).toBeInTheDocument();
  });

  it('cobertura por valor é por empresa: média / total do valor pago', () => {
    resumoMock.mockReturnValue(ok([
      cli({ omieCodigoCliente: 1, valorPago: 750 }),
      cli({ omieCodigoCliente: 2, valorPago: 250, nDocumentos: 2 }), // baixa
      cli({ omieCodigoCliente: 3, company: 'colacor', valorPago: 100, nDocumentos: 2 }),
    ]));
    renderTab();
    expect(screen.getByTestId('ciclo-cobertura-oben')).toHaveTextContent('Cobertura: 75% do valor pago');
    expect(screen.getByTestId('ciclo-cobertura-colacor')).toHaveTextContent('Cobertura: 0%');
    expect(screen.getByTestId('ciclo-cobertura-colacor_sc')).toHaveTextContent('— (sem valor pago em 12 meses)');
  });

  it('erro na receita TTM diz "erro de leitura", não "sem receita"', () => {
    resumoMock.mockReturnValue(ok([]));
    receitaMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('x') });
    renderTab();
    expect(screen.getByTestId('ciclo-card-oben')).toHaveTextContent('erro de leitura da receita TTM');
    expect(screen.getByTestId('ciclo-card-oben')).not.toHaveTextContent('sem receita TTM');
  });

  it('custo é por empresa: em "Todas" a oben calcula e as sem CET mostram "—" sem número', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab('/?cicloEmpresa=all');
    expect(screen.getByTestId('ciclo-desconto-oben')).toHaveTextContent('30 dias');
    expect(screen.getByTestId('ciclo-desconto-colacor')).toHaveTextContent('CET não cadastrado');
    expect(screen.getByTestId('ciclo-desconto-colacor')).not.toHaveTextContent('30 dias');
    expect(screen.getByTestId('ciclo-desconto-colacor_sc')).toHaveTextContent('CET não cadastrado');
  });

  it('elegibilidade: quem já antecipa não conta como elegível; vencido e atraso contam', () => {
    resumoMock.mockReturnValue(ok([
      cli({ omieCodigoCliente: 1, atrasoP80: -5, atrasoP80Valor: -6 }),
      cli({ omieCodigoCliente: 2, atrasoP80: 10, atrasoP80Valor: 12 }),
      cli({ omieCodigoCliente: 3, atrasoP80: null, atrasoP80Valor: null, nVencidas: 1, saldoVencido: 100 }),
      cli({ omieCodigoCliente: 4, atrasoP80: null, atrasoP80Valor: null }),
    ]));
    renderTab('/?cicloEmpresa=oben');
    const t = screen.getByTestId('ciclo-desconto-oben-elegiveis').textContent ?? '';
    expect(t).toMatch(/Elegíveis.*: 2/);
    expect(t).toMatch(/já antecipam.*: 1/);
    expect(t).toMatch(/sem histórico: 1/);
  });

  it('"Todas": fila agrupada por empresa, uma seção cada', () => {
    resumoMock.mockReturnValue(ok([cli({ company: 'oben' }), cli({ company: 'colacor', nomeCliente: 'BETA' })]));
    renderTab('/?cicloEmpresa=all');
    expect(within(screen.getByRole('region', { name: 'Fila Oben' })).getByText('ACME')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Fila Colacor' })).getByText('BETA')).toBeInTheDocument();
  });

  it('linha abre o drill por teclado (Enter e Espaço)', () => {
    resumoMock.mockReturnValue(ok([cli({})]));
    renderTab();
    const linha = screen.getByRole('button', { name: /ACME/ });
    fireEvent.keyDown(linha, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('saldo vencido 0 mostra R$ 0; null mostra "—"', () => {
    resumoMock.mockReturnValue(ok([cli({ saldoVencido: 0 })]));
    renderTab();
    expect(screen.getByRole('button', { name: /ACME/ })).toHaveTextContent(/R\$\s*0/);
  });

  it('saldo vencido null mostra "—" (não R$ 0)', () => {
    resumoMock.mockReturnValue(ok([cli({ saldoVencido: null })]));
    renderTab();
    const linha = screen.getByRole('button', { name: /ACME/ });
    expect(linha).not.toHaveTextContent(/R\$\s*0/);
    expect(within(linha).getAllByRole('cell')[2]).toHaveTextContent('—');
  });

  it('coluna "% valor atrasado": valor e null', () => {
    resumoMock.mockReturnValue(ok([cli({ nomeCliente: 'COM', pctValorAtrasado: 0.35 }), cli({ omieCodigoCliente: 2, nomeCliente: 'SEM', pctValorAtrasado: null })]));
    renderTab();
    expect(screen.getByText('% valor atrasado')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /COM/ })).getAllByRole('cell')[7]).toHaveTextContent('35%');
    expect(within(screen.getByRole('button', { name: /SEM/ })).getAllByRole('cell')[7]).toHaveTextContent('—');
  });

  it('card: "(base: N de 12 meses)" só quando N < 12', () => {
    resumoMock.mockReturnValue(ok([]));
    renderTab();
    expect(screen.getByTestId('ciclo-card-oben')).not.toHaveTextContent('base:');
    expect(screen.getByTestId('ciclo-card-colacor')).toHaveTextContent('(base: 9 de 12 meses)');
    expect(screen.getByTestId('ciclo-card-colacor_sc')).not.toHaveTextContent('base:');
  });

  it('drill: descrição cobre as 4 situações e a conta aberta do cenário de cobrança', () => {
    resumoMock.mockReturnValue(ok([cli({ prazoRealPond: 45, atrasoPond: 15, atrasoP80: 20, atrasoP80Valor: 20, excessoCarenciaPond: 10, pctValorAtrasado: 0.8, volumeEmitido12m: 36500 })]));
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /ACME/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/sem data de baixa.*vencidas em aberto.*status ambíguo/);
    expect(screen.getByTestId('ciclo-drill-conta')).toHaveTextContent(/excesso 10,0 d × R\$\s*100,00\/dia = R\$\s*1\.000 \(cenário, não é previsão\)/);
  });
});

describe('nomeExibido', () => {
  it('decodifica entidade HTML do Omie e cai no código sem nome', () => {
    expect(nomeExibido({ nomeCliente: 'MOVEIS &amp; CIA', omieCodigoCliente: 1 })).toBe('MOVEIS & CIA');
    expect(nomeExibido({ nomeCliente: null, omieCodigoCliente: 42 })).toBe('#42');
  });
});
