import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard — a gravação das recomendações de bundle não pode falhar CALADA.
 *
 * Irmão do `bundle-regras-substituicao-atomica.test.tsx` (mesmo hook, mesmo defeito de
 * classe, outro bloco). Lá o #1574 fechou a substituição de `farmer_association_rules`;
 * aqui fecha o último escritor do engine que ainda descartava o `error`:
 *
 *   for (const cb of allCustomerBundles)
 *     for (const bundle of cb.bundles)
 *       await supabase.from('farmer_bundle_recommendations').insert({ … });  // error ignorado
 *
 * SEVERIDADE MENOR que a do #1574, de propósito: é INSERT puro, sem DELETE — nada é
 * destruído. O pior caso é a recomendação não ser gravada enquanto a UI já mostrou o
 * bundle em memória, então quem lê a TABELA (`OfertaCruaCard`, `useTacticalPlan`) não vê
 * a oferta que o operador acabou de ver na tela. Divergência silenciosa entre a tela e a
 * tabela — o operador não tem como saber que precisa recalcular.
 *
 * DISCRIMINADOR: nenhum caminho em que o INSERT falha pode terminar em `toast.success`.
 * O toast já é honesto quanto às REGRAS (`desfechoRegras`, #1574); passa a ser honesto
 * quanto às RECOMENDAÇÕES pelo mesmo critério.
 *
 * Escrito para sobreviver ao #1520 (que troca `m_bundle`/`lie_bundle` por `affinityBundle`
 * e tira o custo do browser): as asserções olham o TOAST e a CONTAGEM de INSERTs, nunca o
 * shape do payload; e o cenário alimenta as duas fontes de "SKU vendável" — a tabela
 * `product_costs` (hoje) e a RPC `get_skus_margem_positiva` (pós-#1520) — de modo que o
 * mesmo arquivo vale nos dois mundos.
 */
const FARMER = 'farmer-real';
const C1 = 'cliente-1';
const C2 = 'cliente-2';

type Q = { table: string; metodos: string[]; payloads: unknown[] };
type ChamadaRpc = { nome: string; args: Record<string, unknown> };

let queries: Q[] = [];
let rpcs: ChamadaRpc[] = [];
let insertRecsFalha = false;
let regrasFalham = false;
let naLente = false;

const ERRO_INSERT = { code: '23503', message: 'insert or update violates foreign key', details: '', hint: '' };
const ERRO_RPC = { code: '08006', message: 'connection failure', details: '', hint: '' };

/**
 * Sete cestas desenhadas para o Apriori achar P1→P2 e P1→P3 acima dos pisos
 * (minSupport 0.01, minLift 1.05) e para C1/C2 — que só compraram P1 — receberem
 * o bundle {P2,P3}:
 *
 *   itemFreq: P1=4, P2=2, P3=2, P4=3   ·   pair(P1,P2)=pair(P1,P3)=2 de 7 cestas
 *   lift(P1→P2) = (2/4) / (2/7) = 1.75 ≥ 1.05
 *
 * As três cestas de P4 são o RUÍDO que segura o lift acima do piso; sem elas
 * lift(P1→P2) cai para 1.0 e nenhuma regra nasce.
 */
const PEDIDOS = [
  { customer_user_id: C1, items: [{ product_id: 'P1' }], total: 100, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: C2, items: [{ product_id: 'P1' }], total: 100, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: 'c-outro', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-03T00:00:00Z' },
  { customer_user_id: 'c-outro', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-04T00:00:00Z' },
  { customer_user_id: 'c-ruido', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-05T00:00:00Z' },
  { customer_user_id: 'c-ruido', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-06T00:00:00Z' },
  { customer_user_id: 'c-ruido', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-07T00:00:00Z' },
];

const IDS = ['P1', 'P2', 'P3', 'P4'];

const PRODUTOS = IDS.map((id) => ({
  id, codigo: id, descricao: `Produto ${id}`, valor_unitario: 100,
  metadata: null, ativo: true, omie_codigo_produto: null,
}));

/** Custo 40 < preço 100 → margem positiva, o SKU entra no bundle (mundo pré-#1520). */
const CUSTOS = IDS.map((id) => ({ product_id: id, cost_final: 40, cost_price: 40 }));

/** Mesma informação que os custos acima, na forma que o #1520 passa a usar. */
const VENDAVEIS = IDS.map((id) => ({ product_id: id }));

const scoreDe = (cid: string) => ({
  customer_user_id: cid, health_score: 80, answer_rate_60d: 50,
  whatsapp_reply_rate_60d: 50, avg_monthly_spend_180d: 1000,
  gross_margin_pct: 30, category_count: 2, days_since_last_purchase: 10,
});

function dadosDa(tabela: string): unknown[] {
  switch (tabela) {
    // Só C1 e C2 pontuam: 'c-outro' já comprou P2 e P3 (nenhuma regra lhe é aplicável)
    // e 'c-ruido' não tem antecedente. Assim o total de recomendações é exatamente 2.
    case 'farmer_client_scores': return [scoreDe(C1), scoreDe(C2)];
    case 'omie_products': return PRODUTOS;
    case 'product_costs': return CUSTOS;
    case 'profiles': return [
      { user_id: C1, name: 'Cliente 1', customer_type: 'moveleiro', cnae: '3101' },
      { user_id: C2, name: 'Cliente 2', customer_type: 'moveleiro', cnae: '3101' },
    ];
    case 'sales_orders': return PEDIDOS;
    default: return [];
  }
}

/** Desde a migration 20260814223445 a persistência dos bundles não é mais `.insert()` na
 *  tabela: é a RPC que EXPIRA a geração anterior e insere a nova numa transação só. O que
 *  este arquivo mede (a falha não pode passar calada) não mudou — mudou onde ela ocorre. */
const RPC_SUBSTITUIR = 'farmer_bundle_recomendacoes_substituir';

/** Nenhum insert direto deve sobrar nesta tabela — se voltar, o empilhamento volta com ele. */
const ehInsertDiretoDeRecomendacao = (q: Q) =>
  q.table === 'farmer_bundle_recommendations' && q.metodos.includes('insert');

function respostaDe(q: Q) {
  return { data: dadosDa(q.table), error: null, count: 0 };
}

function chain(table: string): unknown {
  const q: Q = { table, metodos: [], payloads: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'eq', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) {
    c[m] = (arg?: unknown) => {
      q.metodos.push(m);
      if (m === 'insert' || m === 'upsert') q.payloads.push(arg);
      return c;
    };
  }
  c.then = (resolve: (v: unknown) => void) => resolve(respostaDe(q));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string, args: Record<string, unknown>) => {
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
      rpcs.push({ nome, args });
      // Pós-#1520 o engine pergunta quais SKUs são vendáveis em vez de baixar custo.
      // PAGINADA (`fetchAllPages`) desde que o cap de 1.000 do PostgREST zerou o motor em
      // prod: o builder de `.rpc()` expõe `.range()` como o de `.from()`, e o dublê tem de
      // expor também. `VENDAVEIS` é curta ⇒ a 1ª página já encerra a paginação.
      if (nome === 'get_skus_margem_positiva') {
        const r = { data: VENDAVEIS, error: null };
        const c: Record<string, unknown> = {
          order: () => c,
          range: () => c,
          then: (resolve: (v: unknown) => void) => resolve(r),
        };
        return c;
      }
      if (nome === RPC_SUBSTITUIR) {
        return Promise.resolve(
          insertRecsFalha ? { data: null, error: ERRO_INSERT } : { data: { expiradas: 0, inseridas: 2 }, error: null },
        );
      }
      if (regrasFalham) return Promise.resolve({ data: null, error: ERRO_RPC });
      return Promise.resolve({ data: 2, error: null });
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: naLente, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));

const toastMock = { error: vi.fn(), success: vi.fn(), warning: vi.fn() };
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastMock.error(...a),
                                    success: (...a: unknown[]) => toastMock.success(...a),
                                    warning: (...a: unknown[]) => toastMock.warning(...a) } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => {
  queries = []; rpcs = [];
  insertRecsFalha = false; regrasFalham = false; naLente = false;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const insertsDeRecomendacao = () => rpcs.filter((r) => r.nome === RPC_SUBSTITUIR);

/** Linhas efetivamente enviadas, somando lote e chamada-a-chamada. */
const linhasEnviadas = () =>
  insertsDeRecomendacao().flatMap((r) => (r.args.p_linhas as Record<string, unknown>[]) ?? []);

const avisos = () => toastMock.warning.mock.calls.map((c) => String(c[0]));

async function calcular() {
  const { result } = renderHook(() => useBundleEngine());
  await act(async () => { await result.current.calculateBundles(); });
  return result;
}

describe('useBundleEngine — a gravação das recomendações de bundle não falha calada', () => {
  it('o cenário gera recomendações (senão os testes abaixo seriam vacuamente verdes)', async () => {
    const result = await calcular();

    expect(linhasEnviadas()).toHaveLength(2);
    expect(result.current.customerBundles.length).toBeGreaterThan(0);
  });

  it('a gravação falhando NÃO emite toast de sucesso — o aviso cita as recomendações', async () => {
    insertRecsFalha = true;
    await calcular();

    // O ponto: falhou, então a tela não pode dizer que gravou.
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    // 'recomenda' é ASCII e exclusivo deste ramo: as mensagens de regra falam em
    // "anteriores seguem valendo" / "preservadas", e a de sucesso em "regras e bundles".
    expect(avisos()[0]).toContain('recomenda');
  });

  it('as duas falhas juntas (regras + recomendações) aparecem no MESMO aviso', async () => {
    regrasFalham = true;
    insertRecsFalha = true;
    await calcular();

    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(avisos()[0]).toContain('recomenda');
    expect(avisos()[0]).toContain('anteriores seguem valendo');
  });

  it('grava as recomendações numa ÚNICA chamada em lote, não uma por vez', async () => {
    await calcular();

    // As linhas são independentes: N round-trips não compram nada e multiplicam a
    // janela de falha parcial (ficar com metade das recomendações gravadas).
    expect(insertsDeRecomendacao()).toHaveLength(1);
    expect(linhasEnviadas()).toHaveLength(2);
  });

  it('NÃO resta insert direto na tabela — o empilhamento voltaria com ele', async () => {
    await calcular();

    // Um `.insert()` direto não expira a geração anterior: é exatamente o writer que a
    // migration 20260814223445 aposentou. Se alguém reintroduzir um (por conveniência, ou
    // resolvendo conflito pelo lado errado), a substituição vira empilhamento de novo e
    // nenhum outro assert deste arquivo perceberia — todos medem a RPC.
    expect(queries.filter(ehInsertDiretoDeRecomendacao)).toHaveLength(0);
  });

  it('a chamada leva run_id e a geração vista (o compare-and-swap da corrida)', async () => {
    await calcular();

    const chamada = insertsDeRecomendacao()[0];
    expect(chamada.args.p_farmer_id).toBe(FARMER);
    expect(String(chamada.args.p_run_id)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Object.prototype.hasOwnProperty.call(chamada.args, 'p_geracao_vista')).toBe(true);
  });

  it('caminho feliz mantém o toast de sucesso', async () => {
    await calcular();

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('a gravação falhando não some com os bundles da tela — só a tabela fica para trás', async () => {
    insertRecsFalha = true;
    const result = await calcular();

    // A severidade menor deste bug mora aqui: a UI em memória segue correta.
    expect(result.current.customerBundles.length).toBeGreaterThan(0);
  });

  it('na lente "Ver como" não grava recomendação nenhuma', async () => {
    naLente = true;
    await calcular();

    expect(insertsDeRecomendacao()).toHaveLength(0);
  });
});
