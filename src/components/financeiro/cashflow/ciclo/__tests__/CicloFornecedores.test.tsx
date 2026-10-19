import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ResumoFornecedor, TituloCp } from '@/lib/financeiro/ciclo-fornecedor-helpers';

const titulosMock = vi.fn();
const resumoMock = vi.fn();
const empresaMock = vi.fn();
const trackMock = vi.fn();

vi.mock('@/hooks/useFinanceiroCicloFornecedor', () => ({
  useCicloCpTitulos: () => titulosMock(),
  useCicloFornecedorResumo: () => resumoMock(),
  useCicloCpEmpresa: () => empresaMock(),
}));
vi.mock('@/hooks/useCashflowProjection', () => ({ useCashflowProjection: () => ({ data: undefined, error: null, isLoading: false }) }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => trackMock(...a) }));

import { CicloFornecedoresSecao } from '@/components/financeiro/cashflow/ciclo/CicloFornecedoresSecao';
import { LinhaPmpCompras } from '@/components/financeiro/cashflow/ciclo/CicloEmpresaCards';

const HOJE = '2026-10-18';
const ok = <T,>(data: T) => ({ data, isLoading: false, error: null });

const forn = (o: Partial<ResumoFornecedor>): ResumoFornecedor => ({
  company: 'oben', fornecedor: 900, nome: 'RENNER SAYERLACK S/A', fonteNome: 'pedido_compra',
  compras12m: 1_680_000, nTitulos12m: 158, nDocumentosPagos: 150, valorPago: 1_500_000,
  prazoConcedidoPond: 10, prazoRealPond: 10.5, atrasoPondSinal: 0.5, atrasoPondPos: 1, nPrazoNegativo: 0,
  valorPagoEmDia: 1_400_000, valorPagoAtrasado: 100_000, valorPagoDataIncerta: 0, valorPagoConfDecisao: 1_450_000,
  descontoObtido12m: 5400, encargoPago12m: 0, nTitulosComDesconto: 27,
  valorVencidoAberto: 96_489, nVencidas: 6, diasVencidoMax: 13, valorAVencer: 40_000, nStatusAmbiguo: 0, ...o,
});
/** 6 NFs a 2% em dia desde ago/2026 + 1 paga com 3 d de atraso sem desconto (R$ 10.000 → perde R$ 200). */
const titulosSayerlack: TituloCp[] = [
  ...[4, 8, 12, 16, 20, 24].map((d, i) => ({
    company: 'oben', fornecedor: 900, lancamento: i + 1, documento: `NF${i}`, emissao: `2026-08-${String(d).padStart(2, '0')}`,
    vencimento: `2026-08-${String(d).padStart(2, '0')}`, dataBaixa: `2026-08-${String(d).padStart(2, '0')}`, dataBaixaConfiavel: true,
    valor: 1000, valorAberto: null, situacao: 'paga' as const, prazoConcedido: 10, prazoReal: 10, atrasoBaixa: 0,
    descontoObtido: 20, descontoInformado: 20, valorPagoPrincipal: 1000, encargoPago: 0, diasVencido: null,
    fonteValorAberto: null,
  })),
  {
    company: 'oben', fornecedor: 900, lancamento: 99, documento: 'NF99', emissao: '2026-09-01', vencimento: '2026-09-11',
    dataBaixa: '2026-09-14', dataBaixaConfiavel: true, valor: 10000, valorAberto: null, situacao: 'paga', prazoConcedido: 10,
    prazoReal: 13, atrasoBaixa: 3, descontoObtido: 0, descontoInformado: 0, valorPagoPrincipal: 10000, encargoPago: 0, diasVencido: null,
    fonteValorAberto: null,
  },
];
const empresa = { pmpComprasPond: 13.07, compras12m: 2_414_503, rsPorDia: 6615.08, pmpEngineControle: 12,
  nForaLista: 119, valorForaLista: 18781.15, nSemCategoria: 0, valorSemCategoria: 0 };

const renderSecao = (url = '/') => render(<MemoryRouter initialEntries={[url]}><CicloFornecedoresSecao empresas={['oben']} hoje={HOJE} /></MemoryRouter>);

beforeEach(() => {
  trackMock.mockReset();
  titulosMock.mockReturnValue(ok(titulosSayerlack));
  resumoMock.mockReturnValue(ok([forn({}), forn({ fornecedor: 8689691709, nome: null, fonteNome: null, valorVencidoAberto: 0, encargoPago12m: null, descontoObtido12m: null })]));
  empresaMock.mockReturnValue(ok({ oben: empresa }));
});

describe('CicloFornecedoresSecao', () => {
  it('mostra a fila "onde o prazo está custando" com o R$ perdido rotulado como cenário', () => {
    renderSecao();
    const fila = screen.getByRole('region', { name: 'Onde o prazo está custando — Oben' });
    expect(within(fila).getByText('RENNER SAYERLACK S/A')).toBeTruthy();
    expect(within(fila).getByText(/R\$\s?200/)).toBeTruthy();
    expect(within(fila).getAllByText(/cenário/).length).toBeGreaterThan(0);
  });
  it('fornecedor sem nome aparece como #código e conta como sem evidência', () => {
    renderSecao();
    expect(screen.getAllByText('#8689691709').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sem evidência \(1\)/)).toBeTruthy();
  });
  it('nenhum texto sugere pedir ou negociar mais prazo', () => {
    const { container } = renderSecao();
    expect(container.textContent ?? '').not.toMatch(/prazo maior|negociar prazo|pedir prazo|mais prazo/);
  });
  it('sem compras → EmptyState com o motivo, sem cards de R$', () => {
    resumoMock.mockReturnValue(ok([]));
    titulosMock.mockReturnValue(ok([]));
    empresaMock.mockReturnValue(ok({ oben: { ...empresa, compras12m: null, rsPorDia: null, pmpComprasPond: null } }));
    renderSecao();
    expect(screen.getByText('Sem compras em 12 meses')).toBeTruthy();
    expect(screen.queryByText(/Desconto obtido/)).toBeNull();
  });
  it('erro de leitura mostra erro, não estado vazio', () => {
    resumoMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    renderSecao();
    expect(screen.getByText(/Não foi possível ler os fornecedores/)).toBeTruthy();
    expect(screen.queryByText('Sem compras em 12 meses')).toBeNull();
  });
  it('KPI apurado com fornecedor sem dado mostra a cobertura (Codex #5), nunca R$ 0 como conclusão', () => {
    renderSecao();
    expect(screen.getByText(/Juros \+ multa pagos/).parentElement?.textContent).toMatch(/1 de 2 fornecedores com dado/);
  });
  it('revisão final: KPIs de % em dia e desconto perdido (cenário), fila rotulada apurado + cenário, contadores no rodapé', () => {
    resumoMock.mockReturnValue(ok([forn({ nPrazoNegativo: 3, valorPagoDataIncerta: 1234, nStatusAmbiguo: 2 })]));
    renderSecao();
    expect(screen.getByText('% pago em dia').parentElement?.textContent).toMatch(/93%/);
    expect(screen.getByText(/Desconto perdido por atraso/).parentElement?.textContent).toMatch(/R\$\s?200.*cenário/);
    expect(screen.getByText('custo do prazo (apurado + cenário)')).toBeTruthy();
    expect(screen.getByText(/3 títulos com prazo concedido negativo/)).toBeTruthy();
    expect(screen.getByText(/R\$\s?1\.234 pagos com data incerta/)).toBeTruthy();
    expect(screen.getByText(/2 títulos com status ambíguo/)).toBeTruthy();
  });
  it('revisão final: fornecedor sem pagas não entra na cobertura de juros', () => {
    resumoMock.mockReturnValue(ok([forn({}), forn({ fornecedor: 77, nDocumentosPagos: 0, valorPago: null, encargoPago12m: null })]));
    renderSecao();
    expect(screen.getByText(/Juros \+ multa pagos/).parentElement?.textContent).not.toMatch(/fornecedores com dado/);
  });
  it('rodapé mostra o sensor de categoria', () => {
    renderSecao();
    expect(screen.getByText(/119 títulos de 2\.01\.\* fora da lista/)).toBeTruthy();
  });
  it('track ao montar e ao abrir o drill', () => {
    renderSecao();
    expect(trackMock).toHaveBeenCalledWith('financeiro.ciclo_fornecedor_secao');
    const tabela = screen.getByRole('table', { name: 'Fornecedores Oben' });
    fireEvent.click(within(tabela).getByText('RENNER SAYERLACK S/A'));
    expect(trackMock).toHaveBeenCalledWith('financeiro.ciclo_fornecedor_drill', { empresa: 'oben' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('drill mostra o desconto OBTIDO (o da tabela) e o selo "valor do título" no aberto estimado', () => {
    titulosMock.mockReturnValue(ok([
      ...titulosSayerlack,
      { ...titulosSayerlack[0], lancamento: 200, documento: 'NF200', descontoObtido: null, descontoInformado: 345.23 },
      { ...titulosSayerlack[0], lancamento: 201, documento: 'NF201', situacao: 'a_vencer' as const, vencimento: '2026-10-30',
        dataBaixa: null, valorAberto: 1000, fonteValorAberto: 'valor_titulo' as const, descontoObtido: null, descontoInformado: null },
    ]));
    renderSecao();
    fireEvent.click(within(screen.getByRole('table', { name: 'Fornecedores Oben' })).getByText('RENNER SAYERLACK S/A'));
    const drill = screen.getByRole('dialog');
    expect(within(drill).getByText('Desconto obtido')).toBeTruthy();
    const nf200 = within(drill).getByText('NF200').closest('tr');
    expect(nf200?.textContent).toMatch(/informado R\$\s?345,23, não confirmado/);
    const nf201 = within(drill).getByText('NF201').closest('tr');
    expect(nf201?.textContent).toMatch(/R\$\s?1\.000,00 \(valor do título\)/);
  });
  it('"conferir boleto" separa sem desconto de desconto abaixo do observado', () => {
    titulosMock.mockReturnValue(ok([
      ...titulosSayerlack,
      { ...titulosSayerlack[0], lancamento: 300, documento: 'NF300', vencimento: '2026-09-20', descontoInformado: 5, descontoObtido: 5 },
    ]));
    renderSecao();
    expect(screen.getByText(/pago em dia com desconto abaixo do observado/)).toBeTruthy();
    expect(screen.queryByText(/pago em dia sem desconto/)).toBeNull();
  });
  it('ordenação e busca da tabela vêm do URL (useUrlState)', () => {
    resumoMock.mockReturnValue(ok([
      forn({}),
      forn({ fornecedor: 5, nome: 'ALFA TINTAS', compras12m: 10, atrasoPondPos: 9 }),
    ]));
    renderSecao('/?fornOrdem=atraso');
    const linhas = () => within(screen.getByRole('table', { name: 'Fornecedores Oben' })).getAllByRole('row').slice(1)
      .map((r) => r.textContent ?? '');
    expect(linhas()[0]).toMatch(/ALFA TINTAS/);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar fornecedor' }), { target: { value: 'sayer' } });
    expect(linhas()).toHaveLength(1);
    expect(linhas()[0]).toMatch(/RENNER SAYERLACK/);
  });
});

describe('LinhaPmpCompras (card de empresa)', () => {
  it('mostra PMP de compras e o R$ de 1 dia como cenário', () => {
    render(<LinhaPmpCompras cp={empresa} />);
    const l = screen.getByTestId('ciclo-pmp-compras');
    expect(l.textContent).toMatch(/PMP de compras: 13,1 d/);
    expect(l.textContent).toMatch(/pagar 1 dia antes consome ≈ R\$\s?6\.615 de caixa; 1 dia depois retém ≈ R\$\s?6\.615 · cenário/);
    expect(l.getAttribute('title')).toBe('O PMP acima inclui imposto, empréstimo e folha; o de compras não.');
  });
  it('revisão final: ponte do PMP do motor para o PMP de compras', () => {
    render(<LinhaPmpCompras cp={empresa} />);
    expect(screen.getByTestId('ciclo-pmp-compras').textContent).toMatch(/PMP do motor 12 d → PMP de compras: 13,1 d/);
  });
  it('R$/dia null → "—", nunca R$ 0', () => {
    render(<LinhaPmpCompras cp={{ ...empresa, rsPorDia: null, pmpComprasPond: null }} />);
    const l = screen.getByTestId('ciclo-pmp-compras');
    expect(l.textContent).toMatch(/PMP de compras: — · pagar 1 dia antes consome ≈ — de caixa/);
    expect(l.textContent).not.toMatch(/R\$\s?0/);
  });
});
