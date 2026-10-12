// Fase 2A — o hook do 1 toque é a fronteira entre o histórico do cliente e o preço do
// MOTOR. Trava os 3 degraus fail-closed: preço com erro (o React Query mantém o mapa
// VELHO), preço recarregando, e leitura do catálogo falhando — nenhum vira atalho.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

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

import { useTintCoresDoClienteUmToque, type AlvoUmToque } from '../useTintCoresDoClienteUmToque';

// Tipo local (importar de vendas seria aresta tintometrico→vendas).
type Product = { id: string; descricao: string; account: string };

const product: Product = { id: 'p1', descricao: 'BASE GL', account: 'oben' };
const alvos: AlvoUmToque<Product>[] = [
  { key: 'a#0', product, codigo: '346J', rotulo: '346J - PLATINA BIANCA 900ML' },
  { key: 'b#0', product, codigo: 'PLATINA', rotulo: 'PLATINA BIANCA' }, // só nome → nunca 1 toque
  { key: 'c#0', product, codigo: '346J', rotulo: '346J - ACRIL BS' }, // código truncado de OUTRA cor
  { key: 'd#0', product, codigo: '346J', rotulo: null }, // item do app: tint_cor_id exato
];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useTintCoresDoClienteUmToque(alvos), { wrapper });
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
    // Codex P1 rodada 2: o rótulo "346J - ACRIL BS" não fala de PLATINA → não é esta cor.
    expect(result.current['c#0']).toBeUndefined();
    // Identidade exata (tint_cor_id do item do app) dispensa o casamento de nome.
    expect(result.current['d#0']).toMatchObject({ formulaId: 'f1' });
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

  it('produto Omie com 2 SKUs → sem atalho (o histórico não diz qual; nunca desempata por UUID)', async () => {
    respostas.tint_skus = { data: [{ id: 'sku-1', omie_product_id: 'p1' }, { id: 'sku-2', omie_product_id: 'p1' }], error: null };
    const { result } = setup();
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current['a#0']).toBeUndefined();
  });

  it('o mesmo código em caixas diferentes na base → ambíguo → sem atalho', async () => {
    respostas.v_tint_formula_canonica = {
      data: [
        { id: 'f1', sku_id: 'sku-1', cor_id: '346J', nome_cor: 'PLATINA BIANCO', preco_csv_legado: 100 },
        { id: 'f9', sku_id: 'sku-1', cor_id: '346j', nome_cor: 'PLATINA OUTRA', preco_csv_legado: 90 },
      ],
      error: null,
    };
    const { result } = setup();
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current['a#0']).toBeUndefined();
  });

  it('leitura do catálogo falhou → nenhum atalho', async () => {
    respostas.v_tint_formula_canonica = { data: null, error: { message: 'timeout' } };
    const { result } = setup();
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current['a#0']).toBeUndefined();
  });
});
