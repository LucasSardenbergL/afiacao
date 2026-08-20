import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Um bundle é "compre estes SKUs JUNTOS" — e SKUs de empresas diferentes do grupo não cabem
 * no mesmo pedido: são dois CNPJs, dois pedidos no Omie, duas identidades de cliente
 * (`submitOrder` exige a identidade PRÓPRIA de cada conta). Um bundle misto é oferta que o
 * fluxo de venda não executa como está escrita.
 *
 * Isto é o OPOSTO da decisão tomada em `useCrossSellEngine`: lá ofertar SKU de outra empresa é
 * legítimo (47,4% dos clientes compram pelas duas) e o sensor só CONTA. Aqui não há leitura
 * benigna, e por isso o sensor tem gatilho: `esperado` é 100%.
 *
 * ⚠️ RISCO LATENTE, não dano vivo — e o caminho não depende de dado novo. Em prod (psql-ro,
 * 20/08/2026) as 24 regras de associação vivas são 24/24 `oben → oben`, ZERO cruzando conta, e
 * os 12 bundles vivos somam 24 SKUs todos `oben`. A razão estrutural: toda regra nasce de um
 * par co-ocorrente no MESMO pedido, e um pedido tem uma conta só — depois do #1807, itens de
 * contas diferentes nem entram na mesma cesta. O que o schema NÃO impede é o passo seguinte:
 * `bundles` de 2 SKUs combinam consequentes de regras DIFERENTES (`relatedRules`), e duas
 * regras aplicáveis ao mesmo cliente podem ser de contas distintas assim que existir uma regra
 * `colacor`. Hoje não existe nenhuma, e é só isso que segura.
 *
 * CENÁRIO: `cli-1` compra pelas DUAS empresas (o caso normal — 139 dos 293 clientes). Ele tem
 * o antecedente `colacor` E o antecedente `oben`, e nenhum dos consequentes. Isso torna
 * aplicáveis regras das duas contas ao mesmo tempo, que é a única porta para o bundle misto.
 */
const FARMER = 'farmer-1';

const A_COL = 'ante-colacor';
const C_COL = 'cons-colacor';
const C_COL2 = 'cons-colacor-2';
const A_OBE = 'ante-oben';
const C_OBE = 'cons-oben';

/** Clientes que formam as cestas de onde as regras nascem. */
const FONTES = ['cli-2', 'cli-3', 'cli-4', 'cli-5', 'cli-6'];

const registros: Array<Record<string, unknown>> = [];
const persistidas: Array<Record<string, unknown>> = [];

/** `false` = `cli-1` não compra `oben`: some o antecedente que abre a porta do bundle misto. */
let alvoCompraOben = true;

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: [
      { customer_user_id: 'cli-1', farmer_id: FARMER, health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50, days_since_last_purchase: 10 },
    ],
    omie_products: [
      { id: A_COL, codigo: 'AC', descricao: 'Antecedente Colacor', valor_unitario: 50, metadata: null, ativo: true, omie_codigo_produto: 1, account: 'colacor' },
      { id: C_COL, codigo: 'CC', descricao: 'Consequente Colacor', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 2, account: 'colacor' },
      { id: C_COL2, codigo: 'CC2', descricao: 'Consequente Colacor 2', valor_unitario: 110, metadata: null, ativo: true, omie_codigo_produto: 3, account: 'colacor' },
      { id: A_OBE, codigo: 'AO', descricao: 'Antecedente Oben', valor_unitario: 60, metadata: null, ativo: true, omie_codigo_produto: 4, account: 'oben' },
      { id: C_OBE, codigo: 'CO', descricao: 'Consequente Oben', valor_unitario: 120, metadata: null, ativo: true, omie_codigo_produto: 5, account: 'oben' },
    ],
    sales_orders: [
      // O alvo tem os ANTECEDENTES e nenhum consequente. Um pedido por conta: o SKU `oben` só
      // resolve dentro de um pedido `oben` (#1807).
      { customer_user_id: 'cli-1', items: [{ omie_codigo_produto: 1, quantity: 1, unit_price: 50 }], total: 50, created_at: '2026-01-01T00:00:00Z', account: 'colacor' },
      ...(alvoCompraOben
        ? [{ customer_user_id: 'cli-1', items: [{ omie_codigo_produto: 4, quantity: 1, unit_price: 60 }], total: 60, created_at: '2026-01-02T00:00:00Z', account: 'oben' }]
        : []),
      // As cestas que produzem as regras — uma por conta, porque a cesta é o PEDIDO.
      ...FONTES.flatMap((cid) => [
        {
          customer_user_id: cid,
          items: [
            { omie_codigo_produto: 1, quantity: 1, unit_price: 50 },
            { omie_codigo_produto: 2, quantity: 1, unit_price: 100 },
            { omie_codigo_produto: 3, quantity: 1, unit_price: 110 },
          ],
          total: 260, created_at: '2026-01-01T00:00:00Z', account: 'colacor',
        },
        {
          customer_user_id: cid,
          items: [
            { omie_codigo_produto: 4, quantity: 1, unit_price: 60 },
            { omie_codigo_produto: 5, quantity: 1, unit_price: 120 },
          ],
          total: 180, created_at: '2026-01-01T00:00:00Z', account: 'oben',
        },
      ]),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_association_rules: [],
    farmer_bundle_recommendations: [],
    farmer_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter', 'contains']) {
    chain[m] = () => chain;
  }
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.insert = () => chain;
  chain.upsert = () => chain;
  chain.update = () => chain;
  chain.delete = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: dados, error: null, count: dados.length });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => stubChain(tabela),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      if (nome === 'farmer_geracao_registrar') registros.push(args ?? {});
      if (nome === 'farmer_bundle_recomendacoes_substituir') persistidas.push(args ?? {});

      if (nome === 'get_skus_margem_positiva') {
        // Builder com `.order()`/`.range()`, NUNCA Promise crua (#1782/#1798). TODOS os
        // consequentes são vendáveis: o gate de custo não pode ser o que separa os desfechos.
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (de: number, ate: number) => {
            (chain as { _de?: number; _ate?: number })._de = de;
            (chain as { _de?: number; _ate?: number })._ate = ate;
            return chain;
          },
          then: (resolve: (v: unknown) => void) => {
            const todos = [{ product_id: C_COL }, { product_id: C_COL2 }, { product_id: C_OBE }, { product_id: A_COL }, { product_id: A_OBE }];
            const c = chain as { _de?: number; _ate?: number };
            resolve({ data: todos.slice(c._de ?? 0, (c._ate ?? todos.length - 1) + 1), error: null });
          },
        };
        return chain;
      }
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    },
  },
}));

vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useBundleEngine } from '../useBundleEngine';

type Bundle = { products: Array<{ id: string }> };
type ResultadoBundle = { current: { customerBundles: Array<{ bundles: Bundle[] }> } };

const CONTA_DO_SKU: Record<string, string> = {
  [A_COL]: 'colacor', [C_COL]: 'colacor', [C_COL2]: 'colacor', [A_OBE]: 'oben', [C_OBE]: 'oben',
};
const ehMisto = (b: Bundle) => new Set(b.products.map((p) => CONTA_DO_SKU[p.id])).size > 1;

const rodar = async () => {
  const { result } = renderHook(() => useBundleEngine());
  await act(async () => { await result.current.calculateBundles(); });
  return result as unknown as ResultadoBundle;
};

const bundlesEmitidos = (r: ResultadoBundle) => r.current.customerBundles.flatMap((cb) => cb.bundles);
const sensorDoHead = () => {
  const insumos = (persistidas[0]?.p_insumos ?? {}) as Record<string, { ok: boolean; n: number; esperado?: number }>;
  return insumos.bundle_conta_unica;
};

beforeEach(() => {
  registros.length = 0;
  persistidas.length = 0;
  alvoCompraOben = true;
  vi.clearAllMocks();
});

describe('useBundleEngine — o bundle MISTO é contado, com gatilho', () => {
  it('A (controle positivo): a fixture PRODUZ bundle, e produz pelo menos um misto', async () => {
    // Sem isto, todo número abaixo poderia vir de "o motor não montou bundle nenhum" — e
    // `n === esperado` com `esperado = 0` é vacuidade, não conformidade.
    const result = await rodar();
    const emitidos = bundlesEmitidos(result);
    expect(emitidos.length).toBeGreaterThan(0);
    expect(emitidos.filter(ehMisto).length).toBeGreaterThan(0);
    expect(persistidas.length).toBeGreaterThan(0);
  });

  it('B: o head declara `bundle_conta_unica`, e o misto sai de `n` sem sair de `esperado`', async () => {
    const result = await rodar();
    const emitidos = bundlesEmitidos(result);
    const sensor = sensorDoHead();
    expect(sensor).toBeTruthy();
    expect(sensor.ok).toBe(true);
    // Amarrado ao que o motor emitiu, não a literais: um número fixo aqui viraria teatro no
    // dia em que a ordenação mudar o top-2.
    expect(sensor.esperado).toBe(emitidos.length);
    expect(sensor.n).toBe(emitidos.filter((b) => !ehMisto(b)).length);
    expect(sensor.n).toBeLessThan(sensor.esperado as number);
  });

  it('C: sem antecedente da outra conta, todo bundle é de conta única — `n === esperado`', async () => {
    // O par do caso B, e o regime de produção de hoje (24/24 regras `oben → oben`). Sem ele,
    // `n < esperado` seria um contador que só sobe e não significaria nada.
    alvoCompraOben = false;
    const result = await rodar();
    const emitidos = bundlesEmitidos(result);
    expect(emitidos.length).toBeGreaterThan(0);
    expect(emitidos.filter(ehMisto)).toHaveLength(0);
    expect(sensorDoHead().n).toBe(sensorDoHead().esperado);
  });

  it('D: o sensor conta o BUNDLE, não o SKU — a unidade é o que se oferta junto', async () => {
    // Contar SKUs diria "24 de 24 na conta do cliente" para um cliente que compra das duas
    // empresas, exatamente no caso em que o bundle é inexequível. A mistura só existe na
    // unidade BUNDLE.
    await rodar();
    const linhas = (persistidas[0]?.p_linhas ?? []) as Array<{ bundle_products: unknown[] }>;
    expect(sensorDoHead().esperado).toBe(linhas.length);
    expect(linhas.every((l) => l.bundle_products.length === 2)).toBe(true);
  });
});
