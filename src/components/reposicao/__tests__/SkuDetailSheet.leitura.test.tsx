import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { RowWithPrice } from '@/lib/reposicao/sku-param';

/**
 * C4 do plano v6 (SKU-DEMANDA): a ficha do SKU fazia `if (error) return null` (stats) e
 * `if (error) return []` (demanda 90d). A query ficava `success`, os stats saíam em branco
 * ("baseado em 0 compras") e o gráfico era desenhado VAZIO sem aviso.
 *
 * Os três estados de cada leitura, que não podem se confundir:
 *  - carregando → esqueleto, nenhum aviso, nenhum "0 compras";
 *  - erro       → aviso nomeado, sem gráfico e sem "0 compras";
 *  - zero observado → SKU parado: gráfico com 90 dias em zero + "Nenhuma venda…" (é fato).
 * O motor de demanda não muda — só o que a ficha afirma sobre a leitura.
 */

type Plano = 'erro' | 'pendente' | { data: unknown };
let plano: Record<string, Plano> = {};

function builder(tabela: string) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order']) q[m] = () => q;
  const responder = () => {
    const p = plano[tabela] ?? { data: tabela === 'venda_items_history' ? [] : null };
    if (p === 'pendente') return new Promise(() => {});
    return Promise.resolve(
      p === 'erro'
        ? { data: null, error: { message: 'permission denied' } }
        : { data: p.data, error: null },
    );
  };
  q.maybeSingle = () => responder();
  q.then = (ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) => responder().then(ok, ko);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => builder(t) },
}));
vi.mock('@/components/reposicao/ConsolidarDemandaDialog', () => ({ ConsolidarDemandaDialog: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SkuDetailSheet } from '../SkuDetailSheet';

beforeAll(() => {
  // o ResponsiveContainer do recharts observa o tamanho; o jsdom não tem ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const SKU = {
  empresa: 'OBEN',
  sku_codigo_omie: 123,
  sku_descricao: 'Verniz PU 3,6L',
  classe_consolidada: 'AX',
  estoque_minimo: 4,
  ponto_pedido: 8,
  estoque_maximo: 20,
  read_only: false,
} as unknown as RowWithPrice;

const STATS_OK = { n_compras: 0, pico_maximo_dia: 3, p95_diario: 2, preco_compra_real: 10 };

function renderFicha() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <SkuDetailSheet sku={SKU} onClose={() => {}} onSaveValues={() => {}} isSaving={false} />
      </QueryClientProvider>,
    ),
  };
}

const corpo = () => document.body.textContent ?? '';

beforeEach(() => {
  plano = {};
});
afterEach(() => {
  onlineManager.setOnline(true);
});

describe('ficha do SKU — demanda 90d (gráfico)', () => {
  it('a query de demanda entra em ERRO quando o select falha (antes ficava success com [])', async () => {
    plano = { venda_items_history: 'erro' };
    const { qc } = renderFicha();
    await waitFor(() =>
      expect(qc.getQueryState(['sku_demanda_90d', 'OBEN', 123])?.error).toMatchObject({
        message: 'permission denied',
      }),
    );
  });

  it('ERRO: aviso no lugar do gráfico — nunca o gráfico vazio mudo', async () => {
    plano = { venda_items_history: 'erro' };
    renderFicha();
    const aviso = await screen.findByTestId('aviso-sku-demanda');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.queryByTestId('sku-demanda-grafico')).toBeNull();
    expect(screen.queryByTestId('sku-demanda-sem-venda')).toBeNull();
  });

  it('CARREGANDO: esqueleto, sem gráfico, sem aviso, sem "nenhuma venda"', async () => {
    plano = { venda_items_history: 'pendente' };
    renderFicha();
    expect(await screen.findByLabelText('Carregando demanda diária')).toBeTruthy();
    expect(screen.queryByTestId('aviso-sku-demanda')).toBeNull();
    expect(screen.queryByTestId('sku-demanda-grafico')).toBeNull();
    expect(screen.queryByTestId('sku-demanda-sem-venda')).toBeNull();
  });

  it('ZERO observado (SKU parado): gráfico + "Nenhuma venda…", sem aviso', async () => {
    renderFicha();
    expect(await screen.findByTestId('sku-demanda-grafico')).toBeTruthy();
    expect(screen.getByTestId('sku-demanda-sem-venda')).toBeTruthy();
    expect(screen.queryByTestId('aviso-sku-demanda')).toBeNull();
  });

  it('com venda observada: gráfico sem a frase de SKU parado', async () => {
    const ontem = new Date(Date.now() - 2 * 86_400_000).toISOString();
    plano = { venda_items_history: { data: [{ data_emissao: ontem, quantidade: 5 }] } };
    renderFicha();
    expect(await screen.findByTestId('sku-demanda-grafico')).toBeTruthy();
    expect(screen.queryByTestId('sku-demanda-sem-venda')).toBeNull();
  });

  it('OFFLINE: aviso de sem rede, não um gráfico vazio', async () => {
    onlineManager.setOnline(false);
    renderFicha();
    const aviso = await screen.findByTestId('aviso-sku-demanda');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
  });
});

describe('ficha do SKU — stats da view (pico, P95, preços, custos)', () => {
  it('a query de stats entra em ERRO quando o select falha (antes ficava success com null)', async () => {
    plano = { v_sku_parametros_sugeridos: 'erro' };
    const { qc } = renderFicha();
    await waitFor(() =>
      expect(qc.getQueryState(['sku_view_stats', 'OBEN', 123])?.error).toMatchObject({
        message: 'permission denied',
      }),
    );
  });

  it('ERRO: aviso visível e nenhum "baseado em 0 compras" fabricado', async () => {
    plano = { v_sku_parametros_sugeridos: 'erro' };
    renderFicha();
    const aviso = await screen.findByTestId('aviso-sku-stats');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(corpo()).not.toMatch(/baseado em/);
  });

  it('CARREGANDO: sem aviso e sem "0 compras"', async () => {
    plano = { v_sku_parametros_sugeridos: 'pendente' };
    renderFicha();
    // o gráfico (outra query) terminou: a ficha já está montada
    await screen.findByTestId('sku-demanda-grafico');
    expect(screen.queryByTestId('aviso-sku-stats')).toBeNull();
    expect(corpo()).not.toMatch(/baseado em/);
  });

  it('ZERO observado (n_compras = 0 lido): "baseado em 0 compras" é fato, sem aviso', async () => {
    plano = { v_sku_parametros_sugeridos: { data: STATS_OK } };
    renderFicha();
    await waitFor(() => expect(corpo()).toMatch(/baseado em 0 compras/));
    expect(screen.queryByTestId('aviso-sku-stats')).toBeNull();
  });
});
