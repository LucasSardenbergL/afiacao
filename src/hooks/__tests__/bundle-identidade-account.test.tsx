import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * O de-para do bundle casava o item com o SKU da EMPRESA ERRADA — e o bundle sumia por isso.
 *
 * `omie_products` declara `UNIQUE (omie_codigo_produto, account)`: o código Omie só é único
 * DENTRO da conta. O motor montava um `Map<number, string>` global sobre o catálogo ativo das
 * duas empresas, então o mesmo código em duas contas virava uma entrada só — e a vencedora era
 * a última que a paginação (`.order('id')`) escreveu. Arbitrária e silenciosa.
 *
 * O cenário abaixo é o que torna o erro OBSERVÁVEL em vez de consistente: o gate de vendáveis
 * (`get_skus_margem_positiva`) julga o `product_id` RESOLVIDO. Se o código do pedido `oben`
 * resolve para o SKU homônimo da `colacor`, o motor pergunta ao gate sobre o SKU errado — e
 * o par de consequentes morre por "não vendável". O farmer não vê bundle nenhum, sem erro,
 * sem toast: o mesmo modo de falha do cap de 1.000 (#1782), por outra causa.
 *
 * ⚠️ Isto é RISCO LATENTE, não dano vivo: em produção (psql-ro, 20/08/2026) ZERO dos 47.798
 * itens lidos resolvem cross-account, e não há um único código compartilhado entre contas nos
 * 7.984 do catálogo. O guard é inerte no dado de hoje — de propósito. Este teste é a única
 * forma de prová-lo, porque o estado que ele barra é o que o SCHEMA autoriza e o dado ainda
 * não tem.
 *
 * CENÁRIO (mesma aritmética dos irmãos `bundle-vendaveis-*`): lift 1,667 para A→B e A→C, acima
 * do minLift de 1,05; o alvo comprou só A, então B e C ficam faltantes e o par (B,C) vira bundle.
 *
 *   cli-2: [A,B,C]   cli-3: [A,B,C]   cli-4: [D]   cli-5: [D]   cli-1(alvo): [A]   — todos `oben`
 */

const rpcArgs: Array<{ nome: string; args: Record<string, unknown> }> = [];

const RPC_SUBSTITUIR = 'farmer_bundle_recomendacoes_substituir';
const RPC_VENDAVEIS = 'get_skus_margem_positiva';

const linhasPersistidas = (): Record<string, unknown>[] =>
  rpcArgs
    .filter((c) => c.nome === RPC_SUBSTITUIR)
    .flatMap((c) => (c.args.p_linhas as Record<string, unknown>[]) ?? []);

const SKU_A = 'sku-a-oben';
const SKU_B = 'sku-b-oben';
const SKU_C = 'sku-c-oben';
const SKU_D = 'sku-d-oben';
/** Homônimo da OUTRA empresa: mesmo `omie_codigo_produto` de SKU_B, conta diferente. */
const SKU_B_COLACOR = 'sku-b-colacor';

const COD = { A: 100, B: 200, C: 300, D: 400 } as const;

/** `true` = o homônimo colacor existe no catálogo (o estado que o schema permite). */
let comColisao = true;
/** Conta gravada nos pedidos. `null` exercita o catálogo/pedido sem conta das outras fixtures. */
let contaDoPedido: string | null = 'oben';

const catalogo = () => {
  const oben = [
    { id: SKU_A, codigo: 'A', descricao: 'Produto A', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: COD.A, account: contaDoPedido },
    { id: SKU_B, codigo: 'B', descricao: 'Produto B', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: COD.B, account: contaDoPedido },
    { id: SKU_C, codigo: 'C', descricao: 'Produto C', valor_unitario: 300, metadata: null, ativo: true, omie_codigo_produto: COD.C, account: contaDoPedido },
    { id: SKU_D, codigo: 'D', descricao: 'Produto D', valor_unitario: 400, metadata: null, ativo: true, omie_codigo_produto: COD.D, account: contaDoPedido },
  ];
  // DEPOIS dos de `oben` de propósito: com um Map global é ele que sobrescreve o código B.
  const colacor = { id: SKU_B_COLACOR, codigo: 'B-SC', descricao: 'Produto B (Colacor)', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: COD.B, account: 'colacor' };
  return comColisao ? [...oben, colacor] : oben;
};

/** SKU_B_COLACOR NÃO é vendável — é o que faz a resolução errada MATAR o par (B,C). */
const vendaveis = () => [{ product_id: SKU_B }, { product_id: SKU_C }];

const pedido = (cliente: string, codigos: number[]) => ({
  customer_user_id: cliente,
  items: codigos.map((c) => ({ omie_codigo_produto: c })),
  total: 100,
  created_at: '2026-01-01T00:00:00Z',
  account: contaDoPedido,
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
    omie_products: catalogo(),
    sales_orders: [
      pedido('cli-2', [COD.A, COD.B, COD.C]),
      pedido('cli-3', [COD.A, COD.B, COD.C]),
      pedido('cli-4', [COD.D]),
      pedido('cli-5', [COD.D]),
      pedido('cli-1', [COD.A]),
    ],
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
    farmer_bundle_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter'];
  for (const m of passthrough) chain[m] = () => chain;
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
      // Leitura BULK do melhor individual — PAGINADA (`fetchAllPages`), então o dublê tem de
      // expor `.order().range()`. Promise crua daria `supabase.rpc(...).order is not a
      // function`, e o engine converteria o bug de CÓDIGO em "comparação indisponível" — o
      // mesmo disfarce que o #1782 documentou.
      if (nome === 'farmer_melhor_individual_por_cliente') {
        const mi: Record<string, unknown> = {
          order: () => mi,
          range: () => mi,
          then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
        };
        return mi;
      }
      rpcArgs.push({ nome, args: args ?? {} });
      if (nome === RPC_VENDAVEIS) {
        // Builder, não Promise crua: o engine encadeia `.order().range()` (#1782).
        let de = 0;
        let ate = 999;
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (d: number, a: number) => { de = d; ate = a; return chain; },
          then: (resolve: (v: unknown) => void) => resolve({ data: vendaveis().slice(de, ate + 1), error: null }),
        };
        return chain;
      }
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    },
  },
}));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'farmer-1' }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { useBundleEngine } from '../useBundleEngine';

const rodar = async () => {
  const { result } = renderHook(() => useBundleEngine());
  await act(async () => { await result.current.calculateBundles(); });
  return result;
};

beforeEach(() => {
  rpcArgs.length = 0;
  comColisao = true;
  contaDoPedido = 'oben';
  impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'farmer-1' });
});

describe('useBundleEngine — identidade do item é o par (conta, código)', () => {
  it('A (controle positivo): SEM o homônimo da outra conta, o cenário GERA e PERSISTE o par (B,C)', async () => {
    // Sem este caso o teste B passaria de graça: "saiu bundle" tem de ser algo que este
    // cenário sabe produzir ANTES de eu afirmar que a colisão o preservou.
    comColisao = false;
    const result = await rodar();
    expect(result.current.customerBundles.flatMap((c) => c.bundles).length).toBeGreaterThan(0);
    expect(linhasPersistidas().length).toBeGreaterThan(0);
  });

  it('B: COM o homônimo `colacor`, o pedido `oben` continua resolvendo para o SKU `oben`', async () => {
    // Com o Map global, o código B resolvia para SKU_B_COLACOR (última escrita). Esse SKU não
    // está em `vendaveis`, então o par (B,C) morria e a tela ficava vazia — sem erro nenhum.
    const result = await rodar();
    const bundles = result.current.customerBundles.flatMap((c) => c.bundles);
    expect(bundles.length).toBeGreaterThan(0);

    const persistidas = linhasPersistidas();
    expect(persistidas.length).toBeGreaterThan(0);
    const ids = (persistidas[0].bundle_products as Array<{ id: string }>).map((p) => p.id).sort();
    expect(ids).toEqual([SKU_B, SKU_C].sort());
    // O SKU da outra empresa não pode aparecer em bundle nenhum.
    expect(persistidas.flatMap((l) => (l.bundle_products as Array<{ id: string }>).map((p) => p.id)))
      .not.toContain(SKU_B_COLACOR);
  });

  it('C: a ORDEM do catálogo não decide mais nada — o `oben` primeiro dá o mesmo resultado', async () => {
    // Prova que "last write wins" acabou: com o Map global, inverter a ordem invertia o
    // desfecho; aqui os dois arranjos têm de produzir o MESMO par.
    const comColacorNoFim = await rodar();
    const idsA = linhasPersistidas().flatMap((l) => (l.bundle_products as Array<{ id: string }>).map((p) => p.id)).sort();
    expect(comColacorNoFim.current.customerBundles.flatMap((c) => c.bundles).length).toBeGreaterThan(0);

    rpcArgs.length = 0;
    comColisao = false; // o arranjo sem o homônimo é o mesmo catálogo `oben`, sem a última escrita
    await rodar();
    const idsB = linhasPersistidas().flatMap((l) => (l.bundle_products as Array<{ id: string }>).map((p) => p.id)).sort();
    expect(idsA).toEqual(idsB);
  });

  it('D: pedido e catálogo SEM conta continuam casando — ausência não vira divergência', async () => {
    // A ausência de `account` é UM estado, não coringa: casa com ausência dos dois lados. Sem
    // isto, qualquer fixture (ou linha legada) sem conta zeraria o motor inteiro em silêncio.
    contaDoPedido = null;
    comColisao = false;
    const result = await rodar();
    expect(result.current.customerBundles.flatMap((c) => c.bundles).length).toBeGreaterThan(0);
  });

  it('E: o head declara `itens_identidade_conforme` — o sensor da divergência, com denominador', async () => {
    // "Sem denominador o achado não julga desenho": o insumo carrega `n`/`esperado` para que
    // `n < esperado` seja a evidência que reabre este achado quando a colisão nascer de verdade.
    await rodar();
    // Com lote NÃO-vazio o head é movido pela própria RPC de substituição, na mesma transação
    // (`registrarVazio` só entra quando não há linha) — é lá que o snapshot viaja.
    const gravacao = rpcArgs.find((c) => c.nome === RPC_SUBSTITUIR);
    expect(gravacao, 'a RPC de substituição precisa ter sido chamada').toBeTruthy();
    const insumos = (gravacao!.args.p_insumos ?? {}) as Record<string, { n: number; esperado?: number }>;
    expect(insumos.itens_identidade_conforme).toBeTruthy();
    expect(insumos.itens_identidade_conforme.n).toBeGreaterThan(0);
    // Nenhuma divergência neste cenário: todo item do pedido `oben` achou o SKU `oben`.
    expect(insumos.itens_identidade_conforme.esperado).toBe(insumos.itens_identidade_conforme.n);
  });
});

/**
 * O guard tem um modo de falha próprio, e ele é MAIS CARO que o bug que fecha: se `account`
 * sumir do `select` de `omie_products`, o catálogo inteiro chega sem conta, TODO item de
 * pedido com conta vira `conta_divergente` e o motor zera — em silêncio, exatamente como o
 * cap de 1.000 fazia (#1782). O achado é do parecer Codex desta entrega.
 *
 * Os testes acima não pegam isso: o stub de `supabase.from()` é passthrough e devolve a
 * fixture inteira, ignorando o que o `select` pediu. Então a FORMA da query precisa ser
 * vigiada como TEXTO — o mesmo recurso que o repo já usa para vigiar a forma das edges.
 */
describe('useBundleEngine — as duas pontas do par vêm do banco', () => {
  const fonte = readFileSync(resolve(process.cwd(), 'src/hooks/useBundleEngine.ts'), 'utf8');

  it('o `select` de `omie_products` pede `account` — sem ele todo item vira divergente', () => {
    const select = fonte.match(/\.select\('id, codigo, descricao[^']*'\)/)?.[0];
    expect(select, 'o select do catálogo mudou de forma — reveja este guard').toBeTruthy();
    expect(select).toContain('account');
  });

  it('o `select` de `sales_orders` pede `account` — é a conta que qualifica cada item', () => {
    const select = fonte.match(/\.select\('customer_user_id, items[^']*'\)/)?.[0];
    expect(select, 'o select de pedidos mudou de forma — reveja este guard').toBeTruthy();
    expect(select).toContain('account');
  });
});
