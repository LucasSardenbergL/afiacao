/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { classificar } from '@/lib/reposicao/raio-x/classificar';
import { fato, HOJE } from '@/lib/reposicao/raio-x/__tests__/fixtures';
import type { LinhaMedicao } from '@/lib/reposicao/raio-x/tipos';

const itens = classificar([
  fato({ sku_codigo_omie: 1, codigo: 'A1', descricao: 'ALFA', cmc: 10, saldo: 5 }),
  fato({ sku_codigo_omie: 2, codigo: 'A10', descricao: 'BETA', cmc: 10, saldo: 5 }),
  fato({ sku_codigo_omie: 3, codigo: 'A100', descricao: 'GAMA', cmc: 10, saldo: 5 }),
], new Map(), 'oben', HOJE);
const linhas: LinhaMedicao[] = [{
  sku_codigo_omie: 1, destino: 'liquidar', decidido_em: '2026-09-01T12:00:00Z', foto_saldo: 5, foto_cmc: 10, foto_valor: 50,
  foto_categoria: 'mercadoria', credito_troca: null, saldo_atual: 5, qtd_vendida: 0, receita: 0, preco_medio_12m: 5,
  compras_apos: ['2026-09-10T12:00:00Z'],
}];

vi.mock('@/contexts/ReposicaoEmpresaContext', () => ({ useReposicaoEmpresa: () => ({ empresa: 'OBEN', setEmpresa: () => {} }) }));
vi.mock('../useRaioX', () => ({
  useRaioX: () => ({
    itens, decisoes: new Map(), syncedHoras: null, isLoading: false, erro: null,
    placar: { total: 0, decidido: 0, pendente: 0, porDestino: {}, topTotal: 0, topDecidido: 0, semCustoN: 0, distorceDio: 0, semCustoDioN: 0 },
  }),
  useRaioXMedicao: () => ({ linhas, isLoading: false, erro: null }),
}));
vi.mock('../DecisaoSheet', () => ({ DecisaoSheet: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import { RaioXTab } from '../RaioXTab';

describe('RaioXTab — contradição filtra por SKU exato', () => {
  it('clicar na contradição do A1 deixa só o A1 (sem A10/A100) e dá para limpar', () => {
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><MemoryRouter><RaioXTab /></MemoryRouter></QueryClientProvider>);
    expect(screen.getAllByText(/A100/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /A1 · Liquidar/ }));
    expect(screen.queryByText('A10')).toBeNull();
    expect(screen.queryByText('A100')).toBeNull();
    expect(screen.getByText(/Filtrando pelo SKU A1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtro do SKU' }));
    expect(screen.queryByText(/Filtrando pelo SKU/)).toBeNull();
    expect(screen.getAllByText(/A100/).length).toBeGreaterThan(0);
  });
});
