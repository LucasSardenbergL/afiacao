import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { GiroSku } from '@/lib/financeiro/ciclo-giro-helpers';

const giroMock = vi.fn();
const trackMock = vi.fn();
vi.mock('@/hooks/useFinanceiroCiclo', () => ({ useCicloGiroSku: (c: string) => giroMock(c) }));
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => trackMock(...a) }));

import { CicloGiroEstoque } from '@/components/financeiro/cashflow/ciclo/CicloGiroEstoque';

const sku = (o: Partial<GiroSku>): GiroSku => ({
  omieCodigoProduto: 1, codigo: 'P1', descricao: 'TINTA &amp; CIA', tipoProduto: '00', familia: 'TINTAS', classe: 'giro',
  divergenciaCadastro: false, saldo: 10, cmc: 10, valorParado: 100, consumoQtd365d: 0, diasCobertura: null,
  ultimaSaida: null, diasSemSaida: null, valorExcedente: null, acao: null, motivoAcao: null, motivoConsumo: null, ...o,
});
const ok = (data: GiroSku[]) => ({ data, isLoading: false, error: null });

const OBEN = [
  sku({ omieCodigoProduto: 1, codigo: 'LIQ1', valorParado: 500, acao: 'liquidar' }),
  sku({ omieCodigoProduto: 2, codigo: 'SEG1', valorParado: 400, valorExcedente: 310, diasCobertura: 400, consumoQtd365d: 365, acao: 'segurar_compra' }),
  sku({ omieCodigoProduto: 3, codigo: 'SEMCUSTO', valorParado: null, cmc: 0 }),
  sku({ omieCodigoProduto: 4, codigo: 'MAQ', classe: 'fora_giro', tipoProduto: '08', familia: 'LIQUIDOS BIO', divergenciaCadastro: true, valorParado: 13275, motivoConsumo: 'fora_do_giro' }),
];

beforeEach(() => {
  giroMock.mockReset();
  trackMock.mockReset();
});

describe('CicloGiroEstoque', () => {
  it('oben: resumo, candidatos e rótulo de cenário', () => {
    giroMock.mockReturnValue(ok(OBEN));
    render(<CicloGiroEstoque empresas={['oben']} acao="todos" onAcao={vi.fn()} />);
    const bloco = screen.getByTestId('ciclo-giro-oben');
    expect(within(bloco).getByText(/cenário — não é previsão/)).toBeInTheDocument();
    expect(within(bloco).getByText('Candidato a liquidar')).toBeInTheDocument();
    expect(within(bloco).getByText('Candidato a segurar compra')).toBeInTheDocument();
    expect(within(bloco).getByText(/confira reservas, lead time e demanda contratada/)).toBeInTheDocument();
    expect(within(bloco).getAllByText('TINTA & CIA').length).toBeGreaterThan(0);
    expect(trackMock).toHaveBeenCalledWith('financeiro.ciclo_giro_visto', { empresa: 'oben' });
  });

  it('valor ausente aparece como —, nunca R$ 0', () => {
    giroMock.mockReturnValue(ok(OBEN));
    render(<CicloGiroEstoque empresas={['oben']} acao="todos" onAcao={vi.fn()} />);
    const linha = screen.getByText('SEMCUSTO').closest('tr')!;
    expect(within(linha).queryByText(/R\$\s*0/)).not.toBeInTheDocument();
    expect(within(linha).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('filtro liquidar mostra só candidatos a liquidar', () => {
    giroMock.mockReturnValue(ok(OBEN));
    render(<CicloGiroEstoque empresas={['oben']} acao="liquidar" onAcao={vi.fn()} />);
    expect(screen.getByText('LIQ1')).toBeInTheDocument();
    expect(screen.queryByText('SEG1')).not.toBeInTheDocument();
  });

  it('lista fora do giro tem selo de conferir cadastro na divergência', () => {
    giroMock.mockReturnValue(ok(OBEN));
    render(<CicloGiroEstoque empresas={['oben']} acao="todos" onAcao={vi.fn()} />);
    const fora = screen.getByTestId('ciclo-giro-fora-oben');
    expect(within(fora).getByText('MAQ')).toBeInTheDocument();
    expect(within(fora).getByText('conferir cadastro')).toBeInTheDocument();
  });

  it('colacor sem fonte de consumo: — com o motivo, R$ parado presente', () => {
    giroMock.mockReturnValue(ok([sku({ omieCodigoProduto: 9, codigo: 'COL1', valorParado: 30, consumoQtd365d: null, motivoConsumo: 'sem_consumo_por_sku' })]));
    render(<CicloGiroEstoque empresas={['colacor']} acao="todos" onAcao={vi.fn()} />);
    const bloco = screen.getByTestId('ciclo-giro-colacor');
    expect(within(bloco).getAllByText(/sem consumo por SKU/).length).toBeGreaterThan(0);
    expect(within(bloco).queryByText('Candidato a liquidar')).not.toBeInTheDocument();
    expect(within(bloco).getAllByText(/R\$\s*30/).length).toBeGreaterThan(0);
  });

  it('erro de leitura mostra mensagem, não lista vazia', () => {
    giroMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') });
    render(<CicloGiroEstoque empresas={['oben']} acao="todos" onAcao={vi.fn()} />);
    expect(screen.getByText(/Não foi possível ler o giro de estoque/)).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum SKU com saldo/)).not.toBeInTheDocument();
  });
});
