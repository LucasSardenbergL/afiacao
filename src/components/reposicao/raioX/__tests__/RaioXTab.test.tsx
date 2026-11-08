/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { classificar } from '@/lib/reposicao/raio-x/classificar';
import { placar } from '@/lib/reposicao/raio-x/placar';
import { fato, HOJE } from '@/lib/reposicao/raio-x/__tests__/fixtures';
import type { LinhaMedicao } from '@/lib/reposicao/raio-x/tipos';

const itens = classificar([
  fato({ sku_codigo_omie: 1, codigo: 'A1', descricao: 'ALFA', cmc: 10, saldo: 5, fornecedor: 'SAYERLACK' }),
  fato({ sku_codigo_omie: 2, codigo: 'A10', descricao: 'BETA', cmc: 10, saldo: 5 }),
  fato({ sku_codigo_omie: 3, codigo: 'A100', descricao: 'GAMA', cmc: 10, saldo: 5 }),
], new Map(), 'oben', HOJE);
const linhas: LinhaMedicao[] = [{
  sku_codigo_omie: 1, destino: 'liquidar', decidido_em: '2026-09-01T12:00:00Z', foto_saldo: 5, foto_cmc: 10, foto_valor: 50,
  foto_categoria: 'mercadoria', credito_troca: null, saldo_atual: 5, qtd_vendida: 0, receita: 0, preco_medio_12m: 5,
  compras_apos: ['2026-09-10T12:00:00Z'],
  troca_contrapartida: null, unidade_estoque: 'UN', unidades_venda_periodo: [],
}];

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-eu' } }) }));
vi.mock('@/contexts/ReposicaoEmpresaContext', () => ({ useReposicaoEmpresa: () => ({ empresa: 'OBEN', setEmpresa: () => {} }) }));
vi.mock('../useRaioX', () => ({
  useRaioX: () => ({
    itens, historicos: [], decisoes: new Map(), syncedHoras: null, isLoading: false, erro: null, coorteEstado: 'congelada',
    placar: placar(itens, new Map()),
  }),
  useRaioXMedicao: () => ({ linhas, isLoading: false, erro: null }),
}));
// Sheet de mentira: mostra o SKU aberto, a origem e expõe salvar/pular — a fila é decidida pela aba.
vi.mock('../DecisaoSheet', () => ({
  DecisaoSheet: (p: { item: { codigo: string }; origem?: string; onSalvo?: () => void; fila?: { onPular: () => void; decididos: number; total: number } | null }) => (
    <div data-testid="sheet">
      <span data-testid="sheet-item">{p.item.codigo}|{p.origem}|{p.fila ? `${p.fila.decididos}/${p.fila.total}` : 'sem-fila'}</span>
      <button onClick={p.onSalvo}>simular salvar</button>
      <button onClick={p.fila?.onPular}>simular pular</button>
    </div>
  ),
}));
const salvar = vi.hoisted(() => vi.fn(() => Promise.resolve('ok')));
vi.mock('../useRaioXMutacoes', () => ({ useRaioXMutacoes: () => ({ salvar, pendente: false }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: vi.fn() }));

import { registrarNoLedger } from '@/lib/analytics-ledger';
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

describe('RaioXTab — sensor de visita (ledger)', () => {
  it('com a leitura pronta registra 1 visita com a empresa, mesmo re-renderizando', () => {
    const qc = new QueryClient();
    const arv = <QueryClientProvider client={qc}><MemoryRouter><RaioXTab /></MemoryRouter></QueryClientProvider>;
    vi.mocked(registrarNoLedger).mockClear();
    const { rerender } = render(arv);
    rerender(arv);
    expect(registrarNoLedger).toHaveBeenCalledTimes(1);
    expect(registrarNoLedger).toHaveBeenCalledWith('reposicao.raio_x_aberta', 'oben', { empresa: 'oben' });
  });

  it('vindo do e-mail (?origem=email) grava a origem e separa o dedup por origem', () => {
    const qc = new QueryClient();
    vi.mocked(registrarNoLedger).mockClear();
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/x?aba=raio-x&origem=email']}><RaioXTab /></MemoryRouter></QueryClientProvider>);
    expect(registrarNoLedger).toHaveBeenCalledTimes(1);
    expect(registrarNoLedger).toHaveBeenCalledWith('reposicao.raio_x_aberta', 'oben:email', { empresa: 'oben', origem: 'email' });
  });

  it('origem fora da allowlist não vai ao ledger (visita sem origem, como antes)', () => {
    const qc = new QueryClient();
    vi.mocked(registrarNoLedger).mockClear();
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/x?origem=lixo']}><RaioXTab /></MemoryRouter></QueryClientProvider>);
    expect(registrarNoLedger).toHaveBeenCalledWith('reposicao.raio_x_aberta', 'oben', { empresa: 'oben' });
  });
});

const montar = () => {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><RaioXTab /></MemoryRouter></QueryClientProvider>);
};

describe('RaioXTab — fila encadeada do Top 61 (UX 3)', () => {
  it('abre o 1º pendente; salvar → próximo; pular → seguinte; ao zerar, fecha', () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Decidir Top 61 (3 pendentes)' }));
    expect(screen.getByTestId('sheet-item').textContent).toBe('A1|fila|0/3');
    fireEvent.click(screen.getByRole('button', { name: 'simular salvar' }));
    expect(screen.getByTestId('sheet-item').textContent).toBe('A10|fila|0/3');
    fireEvent.click(screen.getByRole('button', { name: 'simular pular' }));
    expect(screen.getByTestId('sheet-item').textContent).toBe('A100|fila|0/3');
    fireEvent.click(screen.getByRole('button', { name: 'simular salvar' }));
    // circular: volta ao pulado (A1 e A100 já salvos nesta passagem)
    expect(screen.getByTestId('sheet-item').textContent).toBe('A10|fila|0/3');
    fireEvent.click(screen.getByRole('button', { name: 'simular salvar' }));
    expect(screen.queryByTestId('sheet')).toBeNull();
  });

  it('"Decidir" num item do Top abre como painel (origem sheet) e encadeia na fila ao salvar', () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Decidir A10' }));
    expect(screen.getByTestId('sheet-item').textContent).toBe('A10|sheet|0/3');
    fireEvent.click(screen.getByRole('button', { name: 'simular salvar' }));
    expect(screen.getByTestId('sheet-item').textContent).toBe('A100|fila|0/3');
  });
});

describe('RaioXTab — Confirmar sugestão no card (UX 2)', () => {
  it('1 toque grava a sugestão com o plano padrão e origem card; liquidar sem veredito não ganha atalho', async () => {
    salvar.mockClear();
    montar();
    // A1 (Sayerlack, 0 venda) → trocar; A10/A100 → liquidar sem veredito do servidor → só "Decidir"
    expect(screen.queryByRole('button', { name: /Confirmar Liquidar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Decidir A10' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar Trocar em A1' }));
    expect(salvar).toHaveBeenCalledTimes(1);
    const [args, plano, ctx] = salvar.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(args).toMatchObject({ sku: 1, destino: 'trocar', restaurarMotor: false });
    expect(plano).toMatchObject({ responsavel: 'u-eu', concluido: false, precoPiso: null });
    expect(ctx).toMatchObject({ sku: 1, origem: 'card' });
  });
});

describe('RaioXTab — vazio filtrado (UX 4)', () => {
  it('com itens fora do filtro não diz "Nada parado" e oferece limpar', () => {
    montar();
    fireEvent.change(screen.getByPlaceholderText('Buscar código ou descrição'), { target: { value: 'zzz-inexistente' } });
    expect(screen.queryByText('Nada parado')).toBeNull();
    expect(screen.getByText('Nenhum item com esses filtros')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(screen.getAllByText(/A100/).length).toBeGreaterThan(0);
  });
});
