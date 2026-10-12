// Fase 2A — o hook do 1 toque é a fronteira entre o histórico do cliente e o preço do
// MOTOR. Trava os 3 degraus fail-closed: preço com erro (o React Query mantém o mapa
// VELHO), preço recarregando, e leitura do catálogo falhando — nenhum vira atalho.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Product } from '@/hooks/useUnifiedOrder';

const respostas: Record<string, { data: unknown; error: unknown }> = {};
vi.mock('@/integrations/supabase/client', () => {
  const cadeia = (tabela: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) =>
        prop === 'then'
          ? (ok: (v: unknown) => void) => ok(respostas[tabela] ?? { data: null, error: null })
          : () => cadeia(tabela),
      apply: () => cadeia(tabela),
    });
  return { supabase: { from: (t: string) => cadeia(t) } };
});

const precos = { data: undefined as unknown, isLoading: false, isError: false, isFetching: false };
vi.mock('@/hooks/useTintPricing', () => ({ useTintPrices: () => precos }));

import { useCoresDoClienteUmToque, type AlvoUmToque } from '../useCoresDoClienteUmToque';

const product = { id: 'p1', descricao: 'BASE GL', account: 'oben' } as Product;
const alvos: AlvoUmToque[] = [
  { key: 'a#0', product, codigo: '346J' },
  { key: 'b#0', product, codigo: 'PLATINA' }, // só nome → nunca 1 toque
];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useCoresDoClienteUmToque(alvos), { wrapper });
}

beforeEach(() => {
  respostas.tint_skus = { data: [{ id: 'sku-1', omie_product_id: 'p1' }], error: null };
  respostas.v_tint_formula_canonica = {
    data: [{ id: 'f1', sku_id: 'sku-1', cor_id: '346J', nome_cor: 'PLATINA BIANCO', preco_csv_legado: 100 }],
    error: null,
  };
  Object.assign(precos, { data: { f1: { precoFinal: 130.04, custoCorantes: 2 } }, isLoading: false, isError: false, isFetching: false });
});

describe('useCoresDoClienteUmToque', () => {
  it('fórmula única + preço do motor → pronto (regra do maior), nome-só fica sem atalho', async () => {
    const { result } = setup();
    await waitFor(() => expect(typeof result.current['a#0']).toBe('object'));
    expect(result.current['a#0']).toMatchObject({ formulaId: 'f1', preco: 130.1, fonte: 'calculado', product });
    expect(result.current['b#0']).toBeUndefined();
  });

  it('preço em ERRO com mapa velho no cache → nenhum atalho (Codex P1 da Fase 1)', async () => {
    precos.isError = true;
    const { result } = setup();
    await waitFor(() => expect(result.current).toEqual({}));
    // dá tempo de a leitura do catálogo assentar; o mapa velho segue não valendo
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current['a#0']).toBeUndefined();
  });

  it('preço recarregando após erro → "carregando", nunca o número velho', async () => {
    Object.assign(precos, { isError: true, isFetching: true });
    const { result } = setup();
    await waitFor(() => expect(result.current['a#0']).toBe('carregando'));
  });

  it('leitura do catálogo falhou → nenhum atalho', async () => {
    respostas.v_tint_formula_canonica = { data: null, error: { message: 'timeout' } };
    const { result } = setup();
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current['a#0']).toBeUndefined();
  });
});
