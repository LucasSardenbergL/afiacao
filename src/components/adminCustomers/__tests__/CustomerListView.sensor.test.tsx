import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Customer, ClientScore } from '../types';

const usoMock = vi.fn();
vi.mock('@/lib/nav/sensor-clientes', async (original) => ({
  ...(await original<typeof import('@/lib/nav/sensor-clientes')>()),
  registrarUsoClientes: (u: unknown) => usoMock(u),
}));

import { CustomerListView } from '../CustomerListView';

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
});
beforeEach(() => usoMock.mockClear());

const cliente = (id: string, nome: string): Customer => ({
  user_id: id, name: nome, email: null, phone: null, document: null,
  customer_type: null, created_at: '2026-03-01T00:00:00Z', requires_po: false,
});
const score = (id: string): ClientScore => ({
  customer_user_id: id, health_score: 80, health_class: 'saudavel', churn_risk: 20, expansion_score: 5,
  priority_score: 5, avg_monthly_spend_180d: 1000, days_since_last_purchase: 10, category_count: 3,
  gross_margin_pct: 0.3, sales_history_status: 'ativo',
});

function setup(over: Partial<React.ComponentProps<typeof CustomerListView>> = {}, url = '/admin/customers') {
  const props: React.ComponentProps<typeof CustomerListView> = {
    customers: [cliente('c1', 'Alfa'), cliente('c2', 'Beta')],
    scores: new Map([['c1', score('c1')], ['c2', score('c2')]]),
    loading: false, isError: false, onRetry: vi.fn(), total: 250,
    isCarteira: false, filtroNoServidor: true,
    onSelect: vi.fn(), hasNextPage: true, isFetchingNextPage: false, onLoadMore: vi.fn(),
    ...over,
  };
  const r = render(<MemoryRouter initialEntries={[url]}><CustomerListView {...props} /></MemoryRouter>);
  return { props, ...r };
}

describe('CustomerListView — sensor de uso', () => {
  it('abrir: registra lista_aberta 1x no modo da URL (base completa)', () => {
    const { rerender, props } = setup({}, '/admin/customers?ordem=nome');
    rerender(<MemoryRouter initialEntries={['/admin/customers?ordem=nome']}><CustomerListView {...props} /></MemoryRouter>);
    const aberturas = usoMock.mock.calls.filter(([u]) => u.acao === 'lista_aberta');
    expect(aberturas).toEqual([[{ acao: 'lista_aberta', modo: 'nome' }]]);
  });

  it('carteira abre no modo da ordem que a vendedora vê (padrão: priorizar)', () => {
    setup({ isCarteira: true, filtroNoServidor: false, hasNextPage: false });
    expect(usoMock).toHaveBeenCalledWith({ acao: 'lista_aberta', modo: 'carteira_prioridade' });
  });

  it('carteira tem o seletor de ordem e a troca é medida como carteira', () => {
    setup({ isCarteira: true, filtroNoServidor: false, hasNextPage: false });
    fireEvent.click(screen.getByRole('button', { name: /^Cliente/ }));
    expect(usoMock).toHaveBeenCalledWith({
      acao: 'modo_trocado', de: 'carteira_prioridade', para: 'carteira_nome', origem: 'cabecalho',
    });
  });

  it('não registra abertura enquanto carrega', () => {
    setup({ loading: true });
    expect(usoMock).not.toHaveBeenCalled();
  });

  it('clicar num cliente registra a posição 1-based, o modo e o filtro — sem id do cliente', () => {
    const { props } = setup({}, '/admin/customers?health=critico');
    // com filtroNoServidor a lista não re-filtra em memória: a 2ª linha é a posição 2
    fireEvent.click(screen.getByText('Beta'));
    expect(usoMock).toHaveBeenCalledWith({
      acao: 'cliente_aberto', modo: 'prioridade', posicao: 2, filtroSaude: 'critico', comBusca: false,
    });
    expect(JSON.stringify(usoMock.mock.calls)).not.toContain('c2');
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'c2' }));
  });

  it('trocar de modo pelo cabeçalho registra de>para com a origem', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^Cliente/ }));
    expect(usoMock).toHaveBeenCalledWith({ acao: 'modo_trocado', de: 'prioridade', para: 'nome', origem: 'cabecalho' });
  });

  it('clicar no modo que já está ativo NÃO conta como troca', () => {
    setup({}, '/admin/customers?ordem=nome');
    fireEvent.click(screen.getByRole('button', { name: /^Cliente/ }));
    expect(usoMock.mock.calls.filter(([u]) => u.acao === 'modo_trocado')).toHaveLength(0);
  });

  it('buscar registra só o FATO (sem o termo), depois do debounce', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.change(screen.getByPlaceholderText(/Buscar por nome/), { target: { value: 'marcenaria joao' } });
      act(() => { vi.advanceTimersByTime(350); });
      expect(usoMock).toHaveBeenCalledWith({ acao: 'busca_usada', modo: 'prioridade' });
      expect(JSON.stringify(usoMock.mock.calls)).not.toContain('marcenaria');
    } finally {
      vi.useRealTimers();
    }
  });

  it('filtro de saúde pelo menu registra o valor escolhido', async () => {
    setup({}, '/admin/customers?health=critico');
    // Radix abre o menu por teclado no jsdom (o pointerdown dele exige PointerEvent real).
    fireEvent.keyDown(screen.getByRole('button', { name: /Saúde/ }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Atenção/ }));
    expect(usoMock).toHaveBeenCalledWith({ acao: 'filtro_saude', modo: 'prioridade', valor: 'atencao' });
  });

  it('carregar mais registra a página pedida (2 com 1 página de 100 carregada) e chama onLoadMore', () => {
    const cem = Array.from({ length: 100 }, (_, i) => cliente(`c${i}`, `Cliente ${i}`));
    const { props } = setup({ customers: cem, scores: new Map() });
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(usoMock).toHaveBeenCalledWith({ acao: 'pagina_carregada', modo: 'prioridade', pagina: 2 });
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe('CustomerListView — filtro de saúde na carteira sem scores lidos', () => {
  const carteira = { isCarteira: true, filtroNoServidor: false, hasNextPage: false, scores: new Map() } as const;

  it('scores carregando: avisa e NÃO diz "nenhum cliente" — a lista segue à vista', () => {
    setup({ ...carteira, scoresEstado: 'carregando' }, '/admin/customers?health=critico');
    expect(screen.getByText(/Carregando a saúde dos clientes/)).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum cliente com esses filtros/)).not.toBeInTheDocument();
    expect(screen.getByText('Alfa')).toBeInTheDocument();
  });

  it('scores com falha: alerta com "Tentar novamente" que refaz só os scores', () => {
    const onRetryScores = vi.fn();
    setup({ ...carteira, scoresEstado: 'falha', onRetryScores }, '/admin/customers?health=critico');
    expect(screen.getByRole('alert')).toHaveTextContent(/filtro de saúde NÃO foi aplicado/);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(onRetryScores).toHaveBeenCalledTimes(1);
  });

  it('busca por nome continua valendo com os scores em falha', () => {
    setup({ ...carteira, scoresEstado: 'falha' }, '/admin/customers?health=critico&search=bet');
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Alfa')).not.toBeInTheDocument();
  });

  it('scores lidos: o filtro é aplicado de verdade (nenhum crítico → vazio honesto)', () => {
    setup({ isCarteira: true, filtroNoServidor: false, hasNextPage: false, scoresEstado: 'ok' }, '/admin/customers?health=critico');
    expect(screen.getByText(/Nenhum cliente com esses filtros/)).toBeInTheDocument();
  });
});
