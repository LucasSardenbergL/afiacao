import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Tables } from '@/integrations/supabase/types';

/**
 * Aba "Corantes" (giro de corante Fase 1, advisory). Guards: erro de leitura NUNCA vira "sem consumo"
 * nem "0 ml"; null aparece como "—"; dado parado mostra o último cálculo marcado como velho; o sensor
 * do ledger dispara uma vez e só com a leitura pronta; a aba só existe na OBEN.
 */

let resposta: { data: unknown; error: unknown };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: () => ({ select: () => ({ order: () => Promise.resolve(resposta) }) }) },
}));
const registrarNoLedger = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: (...a: unknown[]) => registrarNoLedger(...a) }));

// Só para o teste da página (aba só na OBEN): o resto da tela fica inerte.
let empresaCtx = 'OBEN';
vi.mock('@/contexts/ReposicaoEmpresaContext', () => ({
  useReposicaoEmpresa: () => ({ empresa: empresaCtx, setEmpresa: () => {} }),
}));
vi.mock('@/components/reposicao/baixoGiro/useBaixoGiro', () => ({
  useBaixoGiro: () => ({
    rows: [], total: 0, truncado: false, isLoading: false, error: null, refetch: vi.fn(),
    kpis: { capitalParado: 0, itensCauda: 0 },
    manterEmEstoque: { isPending: false, mutate: vi.fn() },
    descontinuar: { mutate: vi.fn() }, descontinuarLote: { mutate: vi.fn() }, sobEncomendaLote: { mutate: vi.fn() },
  }),
}));
vi.mock('@/components/reposicao/baixoGiro/useExcessoEstoque', () => ({
  useExcessoEstoque: () => ({ rows: [], kpis: { skusN: 0 }, isLoading: false, error: null }),
}));
vi.mock('@/components/reposicao/raioX/RaioXTab', () => ({ RaioXTab: () => null }));
vi.mock('@/components/reposicao/baixoGiro/BaixoGiroKpis', () => ({ BaixoGiroKpis: () => null }));
vi.mock('@/components/reposicao/baixoGiro/ExcessoKpis', () => ({ ExcessoKpis: () => null }));
vi.mock('@/components/reposicao/baixoGiro/DesovaMissaoDialog', () => ({ DesovaMissaoDialog: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { CorantesTab } from '../CorantesTab';
import AdminReposicaoBaixoGiro from '@/pages/AdminReposicaoBaixoGiro';

const linha = (p: Partial<Tables<'v_corante_giro'>> = {}): Tables<'v_corante_giro'> => ({
  tint_corante_id: 'c1', wp_codigo: 'WP07', descricao: 'WP07.3900', faixa: 'devagar', faixa_ultimo_calculo: 'devagar',
  motivo: null, consumo_ml_dia: 3.2, consumo_ml_dia_60d: 3, giro_mudando: false, ponto_pedido_ml: 60, maior_dosagem_ml: 30,
  lt_dias_corridos: 9, lt_fonte: 'QT', recarga_ml: 810, k_latas: null, teto_l: 0.81, estoque_fechado_l: 1.62,
  excesso_l: 0.81, cmc_l: 101.08, capital_parado: 81.87, demanda_motor_l_dia: 0.004, dias_cobertos: 180,
  confianca: 'alta', fresco: true, coberto_ate: '2026-10-27T20:00:00Z', capacidade_confirmada: true, ...p,
});

const novoQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderAba = () => render(<QueryClientProvider client={novoQc()}><CorantesTab /></QueryClientProvider>);

beforeEach(() => {
  empresaCtx = 'OBEN';
  registrarNoLedger.mockClear();
  resposta = { data: [linha()], error: null };
});

describe('aba Corantes', () => {
  it("erro de leitura não vira 'sem consumo'", async () => {
    resposta = { data: null, error: { message: 'permission denied', code: '42501' } };
    renderAba();
    expect(await screen.findByTestId('aviso-leitura-falhou')).toBeTruthy();
    expect(screen.queryByText(/0 ml/)).toBeNull();
    expect(screen.queryByText('Sem dado de cobertura')).toBeNull();
  });

  it('data=null sem error também é falha, não lista vazia', async () => {
    resposta = { data: null, error: null };
    renderAba();
    expect(await screen.findByTestId('aviso-leitura-falhou')).toBeTruthy();
    expect(screen.queryByText('Sem dado de cobertura')).toBeNull();
  });

  it('faixa fora do vocabulário é falha de leitura, não texto inventado', async () => {
    resposta = { data: [linha({ faixa: 'turbo' })], error: null };
    renderAba();
    expect(await screen.findByTestId('aviso-leitura-falhou')).toBeTruthy();
  });

  it('null aparece como —', async () => {
    resposta = { data: [linha({ excesso_l: null, capital_parado: null, estoque_fechado_l: null })], error: null };
    renderAba();
    const cel = await screen.findByTestId('celula-excesso');
    expect(cel.textContent).toBe('—');
    expect(screen.queryByText(/^0,00 L$/)).toBeNull();
  });

  it('capital nulo com excesso conhecido vira —, nunca R$ 0,00', async () => {
    resposta = { data: [linha({ excesso_l: 0.81, capital_parado: null })], error: null };
    renderAba();
    const cel = await screen.findByTestId('celula-excesso');
    expect(cel.textContent).toContain('0,81 L');
    expect(cel.textContent).toContain('—');
    expect(cel.textContent).not.toMatch(/R\$/);
  });

  it('motivo fora do vocabulário é falha de leitura, não aba pronta', async () => {
    resposta = { data: [linha({ faixa: 'sem_recomendacao', motivo: 'novo_motivo' })], error: null };
    renderAba();
    expect(await screen.findByTestId('aviso-leitura-falhou')).toBeTruthy();
    expect(registrarNoLedger).not.toHaveBeenCalled();
  });

  it('desatualizado mostra o último cálculo', async () => {
    resposta = { data: [linha({ fresco: false, faixa: 'sem_recomendacao', faixa_ultimo_calculo: 'devagar', motivo: 'dado_desatualizado' })], error: null };
    renderAba();
    expect(await screen.findByText(/desatualizado desde/)).toBeTruthy();
    expect(screen.getByText(/gira devagar/)).toBeTruthy();
    // A regra da faixa velha NÃO é apresentada como vigente.
    expect(screen.queryByText('No máximo 1 lata fechada. Pedir 1 QT ao abrir a última.')).toBeNull();
  });

  it('sem nenhuma linha: estado vazio honesto', async () => {
    resposta = { data: [], error: null };
    renderAba();
    expect(await screen.findByText('Sem dado de cobertura')).toBeTruthy();
  });

  it('registra o sensor uma vez quando pronta', async () => {
    const r = renderAba();
    await screen.findByTestId('corante-WP07');
    r.rerender(<QueryClientProvider client={novoQc()}><CorantesTab /></QueryClientProvider>);
    await waitFor(() => expect(registrarNoLedger).toHaveBeenCalledTimes(1));
    expect(registrarNoLedger).toHaveBeenCalledWith('reposicao.corantes_aberta', 'OBEN');
  });

  it('com erro de leitura o sensor não dispara', async () => {
    resposta = { data: null, error: { message: 'x' } };
    renderAba();
    await screen.findByTestId('aviso-leitura-falhou');
    expect(registrarNoLedger).not.toHaveBeenCalled();
  });
});

describe('página: aba só na OBEN', () => {
  const renderPagina = () =>
    render(<QueryClientProvider client={novoQc()}><MemoryRouter><AdminReposicaoBaixoGiro /></MemoryRouter></QueryClientProvider>);

  it('OBEN: o trigger existe e abre a aba', async () => {
    renderPagina();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Corantes' }), { button: 0 });
    expect(await screen.findByTestId('corante-WP07')).toBeTruthy();
  });

  it('COLACOR: o trigger "Corantes" não existe', () => {
    empresaCtx = 'COLACOR';
    renderPagina();
    expect(screen.queryByRole('tab', { name: 'Corantes' })).toBeNull();
  });
});
