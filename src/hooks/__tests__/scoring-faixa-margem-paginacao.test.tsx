import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * A faixa de margem chega CAPADA em 1.000 — e o cliente da cauda vira `neutro` sem ninguém ver.
 *
 * `get_carteira_margem_faixa()` devolve **uma linha por cliente da carteira** e, para quem passa
 * em `cap_carteira_ler` (master/gestor), a carteira é a população INTEIRA. Medido em prod
 * (2026-08-19, psql-ro, reproduzindo `private.margem_cliente_agregada()`): **1.227 linhas**.
 * O PostgREST capa em 1.000 ⇒ **227 clientes (18,5%) somem do `margemPorCliente`**.
 *
 * É a MESMA assinatura do #1782 (`get_skus_margem_positiva`), no mesmo hook: as quatro leituras
 * irmãs — `sales_orders`, `cliente_classificacao`, `carteira_assignments`, `omie_products` —
 * passam por `fetchAllPages`; a RPC era a ÚNICA de fora.
 *
 * O que o truncamento produz não é um erro, é um VEREDITO FABRICADO. Em `useFarmerScoring` o
 * cliente ausente do Map cai em `margemFaixa: mf?.faixa ?? 'neutro'` e `g: mf?.g ?? null` — a
 * faixa vira `neutro` e o health score é calculado com os pesos RENORMALIZADOS, indistinguível
 * de "margem genuinamente não apurável". O bloco que lê a RPC já defende contra o vazio TOTAL
 * (erro de transporte e `data: null` ambos LANÇAM, e o comentário lá diz, com todas as letras,
 * que o `?? []` foi removido porque "mudava a faixa de TODO cliente para neutro em silêncio").
 * Essa defesa é cega ao vazio PARCIAL: o cap entrega exatamente aquele veredito, para 227
 * clientes de cada vez, pela porta dos fundos.
 *
 * O truncamento é do TRANSPORTE, não do dado: por isso o stub abaixo devolve a fatia pedida por
 * `.range()` e, SEM `.range()`, devolve as 1.000 primeiras — que é o que o PostgREST faz. Um
 * stub que devolvesse tudo não provaria nada.
 */

const CLI_CABECA = 'cli-cabeca';
const CLI_CAUDA = 'cli-cauda';
const SKU = 'sku-1';
const RPC_FAIXA = 'get_carteira_margem_faixa';
/** Igual ao `POSTGREST_PAGE_SIZE` de `@/lib/postgrest` — é o cap que estamos reproduzindo. */
const PAGINA = 1000;

const ordenacoesPedidas: string[] = [];
const rpcsChamadas: string[] = [];

/** `true` = o cliente real cai na 2ª página (o defeito). `false` = controle positivo. */
let clienteNaCauda = true;

const faixa = (cid: string) => ({ customer_user_id: cid, faixa: 'verde', motivo: 'saudavel', g: 0.9, margem_pct: 42 });

/** Enche a 1ª página com clientes que não existem na base, empurrando CLI_CAUDA para a 2ª. */
const RUIDO = Array.from({ length: PAGINA - 1 }, (_, i) => faixa(`ruido-${String(i).padStart(4, '0')}`));

const faixasTodas = () =>
  clienteNaCauda
    ? [faixa(CLI_CABECA), ...RUIDO, faixa(CLI_CAUDA)]
    : [faixa(CLI_CABECA), faixa(CLI_CAUDA)];

const pedido = (cid: string) => ({
  id: `ped-${cid}`,
  customer_user_id: cid,
  items: [{ product_id: SKU }],
  total: 1000,
  created_at: '2026-08-01T00:00:00Z',
  order_date_kpi: '2026-08-01',
  status: 'faturado',
});

function linhasPorTabela(): Record<string, Record<string, unknown>[]> {
  return {
    farmer_algorithm_config: [],
    sales_orders: [pedido(CLI_CABECA), pedido(CLI_CAUDA)],
    cliente_classificacao: [],
    carteira_assignments: [],
    omie_products: [{ id: SKU, omie_codigo_produto: 1 }],
    profiles: [
      { user_id: CLI_CABECA, name: 'Cliente Cabeça', phone: '1' },
      { user_id: CLI_CAUDA, name: 'Cliente Cauda', phone: '2' },
    ],
  };
}

function stubChain(tabela: string): unknown {
  const dados = linhasPorTabela()[tabela] ?? [];
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit', 'range', 'or', 'neq', 'filter'];
  for (const m of passthrough) chain[m] = () => chain;
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: dados[0] ?? null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: dados, error: null, count: dados.length });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => stubChain(tabela),
    rpc: (nome: string) => {
      rpcsChamadas.push(nome);
      if (nome === RPC_FAIXA) {
        // Reproduz o PostgREST: SEM `.range()` a resposta vem capada na 1ª página.
        let de = 0;
        let ate = PAGINA - 1;
        const chain: Record<string, unknown> = {
          order: (coluna: string) => { ordenacoesPedidas.push(coluna); return chain; },
          range: (d: number, a: number) => { de = d; ate = a; return chain; },
          then: (resolve: (v: unknown) => void) => resolve({ data: faixasTodas().slice(de, ate + 1), error: null }),
        };
        return chain;
      }
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    },
  },
}));

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'gestor-1' }, isMaster: true, isStaff: true }) }));
vi.mock('@/hooks/useCommercialRole', () => ({ useCommercialRole: () => ({ canViewManagerial: true, loading: false }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'gestor-1' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { useFarmerScoring } from '../useFarmerScoring';

const faixaDe = (scores: Array<{ customer_user_id: string; margemFaixa: string; g: number | null }>, cid: string) =>
  scores.find((s) => s.customer_user_id === cid);

beforeEach(() => {
  ordenacoesPedidas.length = 0;
  rpcsChamadas.length = 0;
  clienteNaCauda = true;
});

describe('useFarmerScoring — a faixa de margem além do cap de 1.000', () => {
  it('A (controle positivo): com os dois clientes na 1ª página, AMBOS recebem a faixa da RPC', async () => {
    // Sem este caso o teste B passaria de graça: `neutro` é o desfecho de QUALQUER insumo
    // faltando, então é preciso provar que o cenário sabe produzir faixa de verdade.
    clienteNaCauda = false;
    const { result } = renderHook(() => useFarmerScoring());
    await act(async () => { await result.current.recalculate(); });

    expect(faixaDe(result.current.clientScores, CLI_CABECA)?.margemFaixa).toBe('verde');
    expect(faixaDe(result.current.clientScores, CLI_CAUDA)?.margemFaixa).toBe('verde');
  });

  it('B: cliente na posição 1.001 mantém a faixa REAL — não vira `neutro` fabricado', async () => {
    const { result } = renderHook(() => useFarmerScoring());
    await act(async () => { await result.current.recalculate(); });

    const cabeca = faixaDe(result.current.clientScores, CLI_CABECA);
    const cauda = faixaDe(result.current.clientScores, CLI_CAUDA);

    // A cabeça prova que o cenário funciona; a cauda é o que o cap comia.
    expect(cabeca?.margemFaixa).toBe('verde');
    expect(cauda?.margemFaixa).toBe('verde');
    // `g` null seria o outro rosto do mesmo defeito: o health score sairia com os pesos
    // renormalizados, sem o componente de margem, e ninguém saberia.
    expect(cauda?.g).toBe(0.9);
  });

  it('C: pagina com `.order` ESTÁVEL — sem ordem total o cap volta de forma intermitente', async () => {
    const { result } = renderHook(() => useFarmerScoring());
    await act(async () => { await result.current.recalculate(); });

    // A função não tem `ORDER BY` próprio: paginar sobre ordem indefinida deixa o plano
    // escolher a ordem de cada página, PULANDO linhas entre elas. `customer_user_id` é uma
    // linha por cliente — ordem total.
    expect(rpcsChamadas).toContain(RPC_FAIXA);
    expect(ordenacoesPedidas).toContain('customer_user_id');
  });
});
