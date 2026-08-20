import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';

/**
 * A coocorrência do cross-sell lia um universo que não existe.
 *
 * O hook filtrava `status IN ('confirmado','faturado','entregue')`. Em prod (psql-ro, 20/08/2026)
 * `confirmado` e `entregue` têm ZERO linhas — e nunca tiveram: `sales_orders` é 100% importada do
 * Omie e o único escritor emite `importado|separacao|enviado|faturado|cancelado`. A allowlist
 * resolvia para só `faturado` e deixava 10.281 pedidos REAIS de fora; os clientes com histórico
 * utilizável caíam de 1.073 para 754.
 *
 * A autoridade do universo money-path é `private.margem_cliente_agregada()`, que filtra por
 * DENYLIST — e o `useFarmerScoring` já foi alinhado a ela no #1738. Este guard fecha o terceiro
 * dos três motores irmãos (nasceram no mesmo dia, com a mesma allowlist).
 *
 * ⚠️ O stub de `supabase.from()` dos testes vizinhos é PASSTHROUGH: ignora `.in()`/`.not()`, então
 * qualquer cenário passa com QUALQUER filtro e o teste não pode ficar vermelho. Aqui o stub de
 * `sales_orders` APLICA os predicados — é o que torna a asserção falsificável. Ele modela só o que
 * este hook usa (`.not(col,'in',…)`, `.is(col,null)`, `.in(col,[…])`, `.range()`); qualquer outro
 * operador LANÇA, em vez de virar filtro silenciosamente ignorado.
 */

const FARMER = 'farmer-1';
const SKU_BASE = 'sku-base';
const SKU_POPULAR = 'sku-popular';
const CONTA = 'oben';

const registros: Array<Record<string, unknown>> = [];
const persistidas: Array<Record<string, unknown>> = [];
/** Predicados que o hook realmente mandou para `sales_orders`, na ordem. */
const filtrosDePedidos: string[] = [];

const pedido = (
  cliente: string,
  produtos: string[],
  status: string | null,
  deletadoEm: string | null = null,
) => ({
  customer_user_id: cliente,
  items: produtos.map((p) => ({ product_id: p, quantity: 1, unit_price: 50 })),
  total: 50 * produtos.length,
  created_at: '2026-01-01T00:00:00Z',
  account: CONTA,
  status,
  deleted_at: deletadoEm,
});

/**
 * A carteira do farmer tem DOIS clientes, e o segundo é o ponto do teste: `cli-9` só tem pedido
 * em `separacao`. Sob a allowlist antiga ele não existia para o motor — é a miniatura dos +319
 * clientes que a denylist devolve ao universo em produção (754 → 1.073).
 */
const CARTEIRA = ['cli-1', 'cli-9'];
const PEDIDOS = [
  pedido('cli-1', [SKU_BASE], 'faturado'), // alvo clássico: comprou só a base
  pedido('cli-9', [SKU_BASE], 'separacao'), // ← na carteira, invisível sob a allowlist
  pedido('cli-2', [SKU_BASE, SKU_POPULAR], 'separacao'), // ← só entra com a denylist
  pedido('cli-3', [SKU_BASE, SKU_POPULAR], 'importado'), // ← só entra com a denylist
  pedido('cli-4', [SKU_BASE, SKU_POPULAR], 'enviado'), // ← só entra com a denylist
  pedido('cli-5', [SKU_BASE, SKU_POPULAR], 'faturado'),
  // NEGATIVOS: pedido cancelado e pedido soft-deletado NÃO são venda. Se entrarem, o número
  // de clientes com pedido passa de 6 — é assim que a exclusão vira asserção, e não fé.
  pedido('cli-6', [SKU_BASE, SKU_POPULAR], 'cancelado'),
  pedido('cli-7', [SKU_BASE, SKU_POPULAR], 'faturado', '2026-02-01T00:00:00Z'),
  // NEGATIVO de PARIDADE: `status` nulo não passa no `not.in` do PostgREST (vira NULL, e NULL
  // não é TRUE) — exatamente como `NOT IN` no corpo de `margem_cliente_agregada()`. Espelhar a
  // autoridade inclui espelhar como ela trata o nulo. Prod tem 0 linhas assim; o teste é o
  // único lugar onde isso é observável.
  pedido('cli-8', [SKU_BASE, SKU_POPULAR], null),
];

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_client_scores: CARTEIRA.map((cid) => ({
      customer_user_id: cid,
      farmer_id: FARMER,
      health_score: 80,
      answer_rate_60d: 50,
      whatsapp_reply_rate_60d: 50,
    })),
    omie_products: [
      { id: SKU_BASE, codigo: 'B', descricao: 'Base', valor_unitario: 50, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 9, account: CONTA },
      { id: SKU_POPULAR, codigo: 'P', descricao: 'Popular', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 9, account: CONTA },
    ],
    sales_orders: PEDIDOS,
    profiles: CARTEIRA.map((cid) => ({ user_id: cid, name: `Cliente ${cid}`, customer_type: 'industria', cnae: '2222' })),
    farmer_category_conversion: [],
    farmer_association_rules: [],
    farmer_recommendations: [],
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
      if (nome === 'farmer_geracao_registrar') registros.push(args ?? {});
      if (nome === 'farmer_recomendacoes_substituir') persistidas.push(args ?? {});
      if (nome === 'get_skus_margem_positiva') {
        // Builder, não Promise crua: o engine encadeia `.order().range()` (#1782/#1798).
        let de = 0;
        let ate = 999;
        const todos = [{ product_id: SKU_BASE }, { product_id: SKU_POPULAR }];
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

vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useCrossSellEngine } from '../useCrossSellEngine';

type ResultadoCrossSell = { current: { recommendations: Array<{ crossSell: Array<{ productId: string }> }> } };

const rodar = async () => {
  const { result } = renderHook(() => useCrossSellEngine());
  await act(async () => { await result.current.calculateRecommendations(); });
  return result;
};

const idsRecomendados = (result: ResultadoCrossSell): string[] =>
  result.current.recommendations.flatMap((c) => c.crossSell).map((r) => r.productId);

/** Os insumos viajam na RPC de substituição (lote não-vazio) ou no registro de vazio. */
const insumosDaExecucao = (): Record<string, { n: number; esperado?: number }> => {
  const fonte = (persistidas[0] ?? registros[0]) as Record<string, unknown> | undefined;
  expect(fonte, 'nenhuma RPC carregou os insumos desta execução').toBeTruthy();
  return (fonte!.p_insumos ?? {}) as Record<string, { n: number; esperado?: number }>;
};

beforeEach(() => {
  registros.length = 0;
  persistidas.length = 0;
  filtrosDePedidos.length = 0;
  vi.clearAllMocks();
});

describe('useCrossSellEngine — o universo de pedidos é a denylist da autoridade', () => {
  it('A: pedido em `separacao`/`importado`/`enviado` ENTRA na coocorrência', async () => {
    await rodar();
    const insumos = insumosDaExecucao();
    // 6 clientes com pedido: cli-1, cli-9, cli-2, cli-3, cli-4, cli-5. Quatro deles só existem
    // sob a denylist — com a allowlist antiga sobrariam 2 e o número abaixo ficaria vermelho.
    expect(insumos.pedidos.n).toBe(6);
  });

  it('B: cliente da carteira cujo ÚNICO pedido é `separacao` volta a ser visível', async () => {
    // A miniatura do efeito medido em prod: a carteira ATIVA é a interseção entre a carteira do
    // farmer e quem tem pedido no universo. `cli-9` só tem `separacao`: sob a allowlist a
    // carteira ativa era 1, e ele não recebia oferta nenhuma — sem erro, sem aviso.
    await rodar();
    const insumos = insumosDaExecucao();
    expect(insumos.carteira_ativa.n).toBe(2);
    expect(insumos.carteira_com_historico_utilizavel.n).toBe(2);
    expect(insumos.carteira_com_historico_utilizavel.esperado).toBe(2);
  });

  it('C: `cancelado` e pedido soft-deletado NÃO entram — a exclusão é medida, não presumida', async () => {
    // `cli-6` (cancelado), `cli-7` (deleted_at) e `cli-8` (status NULO) têm pedido na fixture e
    // NÃO podem contar. Se qualquer um vazar, `pedidos.n` passa de 6 — o número que o caso A trava.
    await rodar();
    const insumos = insumosDaExecucao();
    expect(insumos.pedidos.n).toBe(6);
    expect(insumos.carteira_ativa.n).toBe(2);
  });

  it('D (controle positivo): com o universo certo o motor PRODUZ e PERSISTE a recomendação', async () => {
    // Sem este caso os três acima passariam num motor que não gera nada: "as contas batem" tem
    // de conviver com "a oferta sai", senão o guard vigia um cadáver.
    const result = await rodar();
    expect(idsRecomendados(result)).toContain(SKU_POPULAR);
    expect(persistidas.length).toBeGreaterThan(0);
  });

  it('E: os predicados enviados ao PostgREST são a denylist compartilhada + `deleted_at`', async () => {
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
describe('useCrossSellEngine — a allowlist não volta', () => {
  const fonte = readFileSync(resolve(process.cwd(), 'src/hooks/useCrossSellEngine.ts'), 'utf8');
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
