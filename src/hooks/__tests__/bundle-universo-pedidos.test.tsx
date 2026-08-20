import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';

/**
 * O Apriori do bundle lia um universo que não existe.
 *
 * O hook filtrava `status IN ('confirmado','faturado','entregue')`. Em prod (psql-ro, 20/08/2026)
 * `confirmado` e `entregue` têm ZERO linhas — e nunca tiveram: `sales_orders` é 100% importada do
 * Omie e o único escritor emite `importado|separacao|enviado|faturado|cancelado`. A allowlist
 * resolvia para só `faturado` e deixava 10.281 pedidos REAIS fora das cestas: as cestas do Apriori
 * caíam de 21.579 para 14.653 e os clientes com histórico utilizável de 1.073 para 754.
 *
 * A autoridade do universo money-path é `private.margem_cliente_agregada()`, que filtra por
 * DENYLIST — e o `useFarmerScoring` já foi alinhado a ela no #1738. Este guard fecha o segundo
 * dos três motores irmãos (nasceram no mesmo dia, com a mesma allowlist).
 *
 * ⚠️ O stub de `supabase.from()` dos testes vizinhos é PASSTHROUGH: ignora `.in()`/`.not()`, então
 * qualquer cenário passa com QUALQUER filtro e o teste não pode ficar vermelho. Aqui o stub de
 * `sales_orders` APLICA os predicados — é o que torna a asserção falsificável. Ele modela só o que
 * este hook usa (`.not(col,'in',…)`, `.is(col,null)`, `.in(col,[…])`, `.range()`); qualquer outro
 * operador LANÇA, em vez de virar filtro silenciosamente ignorado.
 */

const RPC_SUBSTITUIR = 'farmer_bundle_recomendacoes_substituir';
const RPC_VENDAVEIS = 'get_skus_margem_positiva';
const RPC_REGISTRAR = 'farmer_geracao_registrar';

const rpcArgs: Array<{ nome: string; args: Record<string, unknown> }> = [];
/** Predicados que o hook realmente mandou para `sales_orders`, na ordem. */
const filtrosDePedidos: string[] = [];

const SKU_A = 'sku-a';
const SKU_B = 'sku-b';
const SKU_C = 'sku-c';
const SKU_D = 'sku-d';
const COD = { A: 100, B: 200, C: 300, D: 400 } as const;
const CONTA = 'oben';

/** `true` = o hook usa a denylist (estado desta entrega). A falsificação troca isto no FONTE. */
const catalogo = () =>
  [
    { id: SKU_A, codigo: 'A', descricao: 'Produto A', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: COD.A, account: CONTA },
    { id: SKU_B, codigo: 'B', descricao: 'Produto B', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: COD.B, account: CONTA },
    { id: SKU_C, codigo: 'C', descricao: 'Produto C', valor_unitario: 300, metadata: null, ativo: true, omie_codigo_produto: COD.C, account: CONTA },
    { id: SKU_D, codigo: 'D', descricao: 'Produto D', valor_unitario: 400, metadata: null, ativo: true, omie_codigo_produto: COD.D, account: CONTA },
  ];

const pedido = (
  cliente: string,
  codigos: number[],
  status: string | null,
  deletadoEm: string | null = null,
) => ({
  customer_user_id: cliente,
  items: codigos.map((c) => ({ omie_codigo_produto: c })),
  total: 100,
  created_at: '2026-01-01T00:00:00Z',
  account: CONTA,
  status,
  deleted_at: deletadoEm,
});

/**
 * A aritmética é a dos irmãos `bundle-*`: 5 cestas, duas com [A,B,C], duas com [D], o alvo com
 * [A] → lift 1,667 para A→B e A→C (acima do minLift 1,05) e o par (B,C) vira bundle.
 *
 * O que muda aqui é QUEM carrega cada cesta: as duas [A,B,C] e uma das [D] só existem sob a
 * DENYLIST. Sob a allowlist antiga sobram 2 cestas e nenhum par — a asserção fica vermelha.
 */
const PEDIDOS = [
  pedido('cli-1', [COD.A], 'faturado'), // alvo: comprou só A, então B e C faltam
  pedido('cli-2', [COD.A, COD.B, COD.C], 'separacao'), // ← só entra com a denylist
  pedido('cli-3', [COD.A, COD.B, COD.C], 'importado'), // ← só entra com a denylist
  pedido('cli-4', [COD.D], 'enviado'), // ← só entra com a denylist
  pedido('cli-5', [COD.D], 'faturado'),
  // NEGATIVOS: pedido cancelado e pedido soft-deletado NÃO são venda. Se entrarem, `baskets`
  // passa de 5 — é assim que a exclusão vira asserção, e não fé.
  pedido('cli-6', [COD.A, COD.B, COD.C], 'cancelado'),
  pedido('cli-7', [COD.A, COD.B, COD.C], 'faturado', '2026-02-01T00:00:00Z'),
  // NEGATIVO de PARIDADE: `status` nulo não passa no `not.in` do PostgREST (vira NULL, e NULL
  // não é TRUE) — exatamente como `NOT IN` no corpo de `margem_cliente_agregada()`. Espelhar a
  // autoridade inclui espelhar como ela trata o nulo. Prod tem 0 linhas assim; o teste é o
  // único lugar onde isso é observável.
  pedido('cli-8', [COD.A, COD.B, COD.C], null),
];

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
    sales_orders: PEDIDOS,
    profiles: [{ user_id: 'cli-1', name: 'Cliente 1', customer_type: 'industria', cnae: '2222' }],
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
    farmer_bundle_recommendations: [],
    farmer_geracao_vigente: [],
  };
}

/** `("a","b","c")` → `['a','b','c']`. É a forma que o PostgREST espera no `not.in`. */
function listaPostgrest(bruto: string): string[] {
  const m = /^\((.*)\)$/.exec(bruto.trim());
  if (!m) throw new Error(`stub: valor de .not(…,'in',…) fora da forma ("a","b"): ${bruto}`);
  return m[1].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
}

type Filtro = (linha: Record<string, unknown>) => boolean;

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const filtraDeVerdade = tabela === 'sales_orders';
  const filtros: Filtro[] = [];
  let de = 0;
  let ate = Number.MAX_SAFE_INTEGER;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lt', 'lte', 'gt', 'order', 'limit', 'or', 'neq', 'filter', 'contains']) {
    chain[m] = () => chain;
  }
  chain.eq = () => chain;
  chain.in = (coluna: string, valores: unknown[]) => {
    if (filtraDeVerdade) {
      filtrosDePedidos.push(`in:${coluna}`);
      filtros.push((l) => valores.includes(l[coluna]));
    }
    return chain;
  };
  chain.not = (coluna: string, op: string, valor: string) => {
    if (filtraDeVerdade) {
      if (op !== 'in') throw new Error(`stub: .not(…, '${op}', …) não modelado`);
      const proibidos = listaPostgrest(valor);
      filtrosDePedidos.push(`not.in:${coluna}=${valor}`);
      // NULL-BLIND, como o PostgREST: `not.in` vira `NOT (col IN (…))`, que é NULL — logo
      // NÃO passa — quando a coluna é nula. Um stub que deixasse o nulo passar mentiria a
      // favor da mudança (universo maior do que o real). Prod tem 0 status nulo hoje, mas o
      // harness não pode divergir do operador que ele afirma reproduzir.
      filtros.push((l) => l[coluna] != null && !proibidos.includes(String(l[coluna])));
    }
    return chain;
  };
  chain.is = (coluna: string, valor: unknown) => {
    if (filtraDeVerdade) {
      if (valor !== null) throw new Error(`stub: .is(…, ${String(valor)}) não modelado`);
      filtrosDePedidos.push(`is.null:${coluna}`);
      filtros.push((l) => l[coluna] == null);
    }
    return chain;
  };
  chain.range = (d: number, a: number) => {
    de = d;
    ate = a;
    return chain;
  };
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.insert = () => chain;
  chain.upsert = () => chain;
  chain.update = () => chain;
  chain.delete = () => chain;
  chain.then = (resolver: (v: unknown) => void) => {
    const linhas = filtros.length ? dados.filter((l) => filtros.every((f) => f(l))) : dados;
    const pagina = linhas.slice(de, ate === Number.MAX_SAFE_INTEGER ? undefined : ate + 1);
    resolver({ data: pagina, error: null, count: linhas.length });
  };
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => stubChain(tabela),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      if (nome === 'farmer_melhor_individual_por_cliente') {
        return Promise.resolve({ data: [], error: null });
      }
      rpcArgs.push({ nome, args: args ?? {} });
      if (nome === RPC_VENDAVEIS) {
        // Builder, não Promise crua: o engine encadeia `.order().range()` (#1782).
        let de = 0;
        let ate = 999;
        const todos = [{ product_id: SKU_B }, { product_id: SKU_C }];
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: (d: number, a: number) => { de = d; ate = a; return chain; },
          then: (r: (v: unknown) => void) => r({ data: todos.slice(de, ate + 1), error: null }),
        };
        return chain;
      }
      return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) };
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

/** Os insumos viajam na RPC de substituição (lote não-vazio) ou no registro de vazio. */
const insumosDaExecucao = (): Record<string, { n: number; esperado?: number }> => {
  const gravacao = rpcArgs.find((c) => c.nome === RPC_SUBSTITUIR) ?? rpcArgs.find((c) => c.nome === RPC_REGISTRAR);
  expect(gravacao, 'nenhuma RPC carregou os insumos desta execução').toBeTruthy();
  return (gravacao!.args.p_insumos ?? {}) as Record<string, { n: number; esperado?: number }>;
};

beforeEach(() => {
  rpcArgs.length = 0;
  filtrosDePedidos.length = 0;
  impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'farmer-1' });
});

describe('useBundleEngine — o universo de pedidos é a denylist da autoridade', () => {
  it('A: pedido em `separacao`/`importado`/`enviado` ENTRA nas cestas do Apriori', async () => {
    await rodar();
    const insumos = insumosDaExecucao();
    // 5 cestas: cli-1..cli-5. Três delas (cli-2, cli-3, cli-4) só existem sob a denylist —
    // com a allowlist antiga sobrariam 2 e o número abaixo ficaria vermelho.
    expect(insumos.baskets.n).toBe(5);
    // `pedidos` conta CLIENTE com pedido, não pedido: os mesmos 5.
    expect(insumos.pedidos.n).toBe(5);
  });

  it('B: `cancelado` e pedido soft-deletado NÃO entram — a exclusão é medida, não presumida', async () => {
    await rodar();
    const insumos = insumosDaExecucao();
    // `esperado` de `baskets` é o total de pedidos LIDOS. Os 8 da fixture menos o `cancelado`
    // (denylist), o `deleted_at` (o `.is`) e o de status NULO (o `not.in` é NULL-blind) dão 5:
    // se qualquer um dos três vazar, o número sobe.
    expect(insumos.baskets.esperado).toBe(5);
    expect(insumos.baskets.n).toBe(5);
  });

  it('C (controle positivo): com o universo certo o motor PRODUZ e PERSISTE o par (B,C)', async () => {
    // Sem este caso os dois acima passariam num motor que não gera nada: "as contas batem" tem
    // de conviver com "o bundle sai", senão o guard vigia um cadáver.
    const result = await rodar();
    const bundles = result.current.customerBundles.flatMap((c) => c.bundles);
    expect(bundles.length).toBeGreaterThan(0);
    const persistidas = (rpcArgs.find((c) => c.nome === RPC_SUBSTITUIR)?.args.p_linhas ?? []) as Record<string, unknown>[];
    expect(persistidas.length).toBeGreaterThan(0);
    const ids = (persistidas[0].bundle_products as Array<{ id: string }>).map((p) => p.id).sort();
    expect(ids).toEqual([SKU_B, SKU_C].sort());
  });

  it('D: os predicados enviados ao PostgREST são a denylist compartilhada + `deleted_at`', async () => {
    // Vigia a FORMA da query, não só o efeito: o efeito acima passaria com uma denylist
    // AMPLIADA à mão (que divergiria de `margem_cliente_agregada()` sem ninguém notar).
    await rodar();
    expect(filtrosDePedidos).toContain(`not.in:status=${STATUS_NAO_VENDA_POSTGREST}`);
    expect(filtrosDePedidos).toContain('is.null:deleted_at');
    // E nenhuma allowlist de status voltou por outro caminho.
    expect(filtrosDePedidos.filter((f) => f === 'in:status')).toEqual([]);
  });
});

/**
 * Guard TEXTUAL, par do comportamental acima. O `.in('status', …)` volta em rebase/merge sem
 * quebrar typecheck, lint nem tela — e o stub acima só o pega se o cenário continuar exatamente
 * este. Ler o fonte é o que cobre o hook inteiro. (Padrão de `universoPedidos.test.ts`, #1738.)
 */
describe('useBundleEngine — a allowlist não volta', () => {
  const fonte = readFileSync(resolve(process.cwd(), 'src/hooks/useBundleEngine.ts'), 'utf8');
  const semComentarios = fonte
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

  it('o hook não filtra `status` por allowlist', () => {
    expect(
      /\.in\(\s*['"]status['"]/.test(semComentarios),
      'o hook voltou a filtrar status por allowlist — diverge de margem_cliente_agregada()',
    ).toBe(false);
  });

  it('o hook consome a denylist compartilhada e filtra `deleted_at`', () => {
    expect(semComentarios).toContain('STATUS_NAO_VENDA_POSTGREST');
    expect(
      /\.is\(\s*['"]deleted_at['"]\s*,\s*null\s*\)/.test(semComentarios),
      'a denylist sozinha traria pedido apagado — o `deleted_at` anda junto',
    ).toBe(true);
  });
});
