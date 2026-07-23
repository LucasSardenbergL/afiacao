import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — a substituição das regras de associação não pode ZERAR a tabela.
 *
 * `farmer_association_rules` é GLOBAL (não tem farmer_id) e o engine a substituía assim:
 *
 *   await supabase.from('farmer_association_rules').delete().neq('id', '000…');  // apaga TUDO
 *   if (discoveredRules.length > 0) await supabase.from(…).insert(rulesToInsert);
 *
 * Três defeitos num bloco de cinco linhas: (1) DELETE e INSERT são chamadas PostgREST
 * separadas — logo transações separadas — e uma falha entre elas deixa a tabela VAZIA;
 * (2) o `error` das duas era descartado e o toast de sucesso saía do mesmo jeito, então o
 * operador via "N regras gravadas" com a tabela zerada; (3) sem lote (0 regras) o DELETE
 * rodava sozinho.
 *
 * O estrago não fica no bundle engine — cinco consumidores leem essa tabela e nenhum
 * distingue "sem regra" de "zerada": `get_meu_mixgap` (card MixGap em FarmerCalls),
 * `melhoria_produtos_relacionados` (canal Melhorias, em prod), a edge `recommend`
 * (assoc_score, peso w_assoc), o `useCrossSellEngine` e o próprio bundle engine.
 *
 * DISCRIMINADOR: nenhum `delete()` sobre `farmer_association_rules` pode partir do cliente.
 * A troca inteira vai por `farmer_association_rules_substituir`, que faz DELETE+INSERT numa
 * transação (provada em db/test-farmer-association-rules-atomica.sh).
 *
 * Irmão de `bundle-escopo-sob-falha.test.tsx` (mesmo hook, outro defeito).
 */
const FARMER = 'farmer-real';
const CLIENTE = 'cliente-1';

type Q = { table: string; metodos: string[] };
type ChamadaRpc = { nome: string; args: Record<string, unknown> };

let queries: Q[] = [];
let rpcs: ChamadaRpc[] = [];
let rpcFalha = false;
let semPedidos = false;
let naLente = false;

const ERRO_RPC = { code: '08006', message: 'connection failure', details: '', hint: '' };

/**
 * Quatro cestas desenhadas para o Apriori achar UMA regra acima dos pisos
 * (minSupport 0.01, minLift 1.05): P1 e P2 só aparecem juntos, P3 sozinho.
 * lift(P1→P2) = conf/support(P2) = 1 / (2/4) = 2.
 */
const PEDIDOS = [
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }], total: 100, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }], total: 100, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P3' }], total: 50, created_at: '2026-07-03T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P3' }], total: 50, created_at: '2026-07-04T00:00:00Z' },
];

const PRODUTOS = ['P1', 'P2', 'P3'].map((id) => ({
  id, codigo: id, descricao: `Produto ${id}`, valor_unitario: 100,
  metadata: null, ativo: true, omie_codigo_produto: null,
}));

function dadosDa(tabela: string): unknown[] {
  switch (tabela) {
    case 'farmer_client_scores':
      return [{ customer_user_id: CLIENTE, health_score: 80, answer_rate_60d: 50,
                whatsapp_reply_rate_60d: 50, avg_monthly_spend_180d: 1000,
                gross_margin_pct: 30, category_count: 2, days_since_last_purchase: 10 }];
    case 'omie_products': return PRODUTOS;
    case 'profiles': return [{ user_id: CLIENTE, name: 'Cliente 1', customer_type: 'moveleiro', cnae: '3101' }];
    case 'sales_orders': return semPedidos ? [] : PEDIDOS;
    default: return [];
  }
}

function chain(table: string): unknown {
  const q: Q = { table, metodos: [] };
  queries.push(q);
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'eq', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => { q.metodos.push(m); return c; };
  c.then = (resolve: (v: unknown) => void) => resolve({ data: dadosDa(table), error: null, count: 0 });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      return Promise.resolve(rpcFalha ? { data: null, error: ERRO_RPC } : { data: 2, error: null });
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
  rpcFalha = false; semPedidos = false; naLente = false;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** DELETE partindo do cliente sobre a tabela global = o defeito de volta. */
const deletesNaTabelaDeRegras = () =>
  queries.filter((q) => q.table === 'farmer_association_rules' && q.metodos.includes('delete'));

const substituicoes = () => rpcs.filter((r) => r.nome === 'farmer_association_rules_substituir');

async function calcular() {
  const { result } = renderHook(() => useBundleEngine());
  await act(async () => { await result.current.calculateBundles(); });
  return result;
}

describe('useBundleEngine — troca de regras é atômica ou não acontece', () => {
  it('substitui via RPC e nunca apaga a tabela pelo cliente', async () => {
    await calcular();

    expect(deletesNaTabelaDeRegras()).toHaveLength(0);
    expect(substituicoes()).toHaveLength(1);

    const lote = substituicoes()[0].args.p_regras as Array<Record<string, unknown>>;
    expect(lote.length).toBeGreaterThan(0);
    expect(lote[0]).toMatchObject({ rule_type: expect.stringMatching(/^(association|sequential)$/) });
  });

  it('RPC falhando NÃO emite toast de sucesso — e nada foi apagado', async () => {
    rpcFalha = true;
    await calcular();

    // O ponto do parecer: falhou, então a tela não pode dizer que gravou.
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(String(toastMock.warning.mock.calls[0][0])).toContain('anteriores seguem valendo');

    // E as regras que já estavam lá sobrevivem, porque nenhum DELETE partiu daqui.
    expect(deletesNaTabelaDeRegras()).toHaveLength(0);
  });

  it('caminho feliz mantém o toast de sucesso', async () => {
    await calcular();

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('zero regras descobertas preserva as vigentes — não chama a RPC nem apaga', async () => {
    semPedidos = true;
    await calcular();

    expect(substituicoes()).toHaveLength(0);
    expect(deletesNaTabelaDeRegras()).toHaveLength(0);
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(String(toastMock.warning.mock.calls[0][0])).toContain('preservadas');
  });

  it('na lente "Ver como" não escreve nada (o master inspeciona, não regrava)', async () => {
    naLente = true;
    await calcular();

    expect(substituicoes()).toHaveLength(0);
    expect(deletesNaTabelaDeRegras()).toHaveLength(0);
  });
});
