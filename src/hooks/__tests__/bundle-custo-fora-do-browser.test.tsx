import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * FU4-F fase 3 / PR-B — o custo sai do BROWSER (useBundleEngine).
 *
 * Irmão de cross-sell-custo-fora-do-browser.test.tsx (arquivos separados porque os dois engines
 * vivem em módulos diferentes: useBundleEngine é `farmer-inteligencia`, useCrossSellEngine é
 * `vendas` — um teste importando os dois seria vazamento de fronteira).
 *
 * O engine baixava `public.product_costs` inteira e calculava margem no cliente. Agora quem
 * responde "este SKU é vendável?" é `public.get_skus_margem_positiva()`.
 *
 * ⚠️ O fail-closed só vale por causa do controle positivo: sem ele, "nenhum bundle" passaria
 * trivialmente (o engine devolve vazio quando falta qualquer insumo).
 *
 * CENÁRIO: o engine MINERA as regras dos pedidos (não lê farmer_association_rules). Os baskets
 * abaixo dão lift 1,667 para A→B e A→C, acima do minLift de 1,05 — e o cliente-alvo comprou só A,
 * então B e C ficam como consequentes faltantes e o par (B,C) vira bundle.
 *
 *   cli-2: [A,B,C]   cli-3: [A,B,C]   cli-4: [D]   cli-5: [D]   cli-1(alvo): [A]
 *   freq: A=3 B=2 C=2 D=2 · totalBaskets=5
 *   A→B: conf = 2/3 = 0,667 · lift = 0,667 / (2/5) = 1,667 ✓
 */

const tabelasLidas: string[] = [];
const rpcsChamadas: string[] = [];
const inserts: Array<{ tabela: string; linha: Record<string, unknown> }> = [];

let rpcResultado: { data: unknown; error: unknown } = { data: [], error: null };

const SKU_A = 'sku-a-comprado';
const SKU_B = 'sku-b-vendavel';
const SKU_C = 'sku-c-vendavel';
const SKU_D = 'sku-d-ruido';

const pedido = (cliente: string, produtos: string[]) => ({
  customer_user_id: cliente,
  items: produtos.map((id) => ({ product_id: id })),
  total: 100,
  created_at: '2026-01-01T00:00:00Z',
});

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      {
        customer_user_id: 'cli-1',
        farmer_id: 'farmer-1',
        health_score: 80,
        answer_rate_60d: 50,
        whatsapp_reply_rate_60d: 50,
        avg_monthly_spend_180d: 1000,
        gross_margin_pct: 20,
        category_count: 3,
        days_since_last_purchase: 10,
      },
    ],
    omie_products: [
      { id: SKU_A, codigo: 'A', descricao: 'Produto A', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 1 },
      { id: SKU_B, codigo: 'B', descricao: 'Produto B', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 2 },
      { id: SKU_C, codigo: 'C', descricao: 'Produto C', valor_unitario: 300, metadata: null, ativo: true, omie_codigo_produto: 3 },
      { id: SKU_D, codigo: 'D', descricao: 'Produto D', valor_unitario: 400, metadata: null, ativo: true, omie_codigo_produto: 4 },
    ],
    sales_orders: [
      pedido('cli-2', [SKU_A, SKU_B, SKU_C]),
      pedido('cli-3', [SKU_A, SKU_B, SKU_C]),
      pedido('cli-4', [SKU_D]),
      pedido('cli-5', [SKU_D]),
      pedido('cli-1', [SKU_A]),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
    farmer_bundle_recommendations: [],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter', 'contains'];
  for (const m of passthrough) chain[m] = () => chain;
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.insert = (linha: Record<string, unknown>) => { inserts.push({ tabela, linha }); return chain; };
  chain.upsert = () => chain;
  chain.update = () => chain;
  chain.delete = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: dados, error: null, count: dados.length });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => { tabelasLidas.push(tabela); return stubChain(tabela); },
    rpc: (nome: string) => {
      rpcsChamadas.push(nome);
      return { then: (resolve: (v: unknown) => void) => resolve(rpcResultado) };
    },
  },
}));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'farmer-1' }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => {
  tabelasLidas.length = 0;
  rpcsChamadas.length = 0;
  inserts.length = 0;
  rpcResultado = { data: [{ product_id: SKU_B }, { product_id: SKU_C }], error: null };
  impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'farmer-1' });
});

describe('useBundleEngine — custo fora do browser', () => {
  it('A (controle positivo): com a RPC devolvendo os SKUs, o engine GERA bundle', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    const bundles = result.current.customerBundles.flatMap((c) => c.bundles);
    expect(bundles.length).toBeGreaterThan(0);
  });

  it('B (fail-closed): RPC falha → nenhum bundle', async () => {
    rpcResultado = { data: null, error: { message: 'permission denied' } };
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(result.current.customerBundles.flatMap((c) => c.bundles)).toEqual([]);
    expect(inserts.filter((i) => i.tabela === 'farmer_bundle_recommendations')).toEqual([]);
  });

  it('C: não lê product_costs — consulta a RPC', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(tabelasLidas).not.toContain('product_costs');
    expect(rpcsChamadas).toContain('get_skus_margem_positiva');
  });

  it('D: bundle_products não carrega "cost"/"margin" por SKU', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    const linhas = inserts.filter((i) => i.tabela === 'farmer_bundle_recommendations').map((i) => i.linha);
    expect(linhas.length).toBeGreaterThan(0); // controle positivo: houve o que gravar
    for (const linha of linhas) {
      const produtos = (linha.bundle_products ?? []) as Record<string, unknown>[];
      expect(produtos.length).toBeGreaterThan(0);
      for (const p of produtos) {
        expect(p).not.toHaveProperty('cost');
        expect(p).not.toHaveProperty('margin');
      }
    }
  });
});
