import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — o head NÃO pode dizer "vazio/completo" depois de o motor ter produzido
 * linhas que não chegaram ao banco.
 *
 * Achado do challenge Codex (gpt-5.6-sol, xhigh) sobre a própria entrega que passou o `catch`
 * a mover o head. O motor publica o resultado em memória (`aplicarBundles`) ANTES de gravar.
 * Se a RPC de substituição REJEITA, o `catch` chamava `registrarVazio()` incondicionalmente —
 * e como a gravação não commitou, o head no banco não mudou, então o compare-and-swap ACEITA
 * o registro. Com todos os insumos lidos, `avaliarCompletude` devolve `completo`.
 *
 * O resultado é o pior sinal possível: `resultado='vazio'` + `completude='completo'` para uma
 * execução que calculou bundles. É exatamente a licença que a fase 2 usaria para EXPIRAR a
 * carteira — apagando as recomendações antigas por causa de uma falha de persistência.
 *
 * O CAS só protege quando a gravação COMMITOU (e aí a recusa vem como FG107, que checa linhas
 * do mesmo run_id, antes mesmo do FG106). Falha ANTES do commit passa reto.
 *
 * DISCRIMINADOR: nenhum registro de head com `p_resultado='vazio'` quando houve linhas.
 */
const FARMER = 'farmer-real';

let falharGravacao = true;
const registros: Array<Record<string, unknown>> = [];

/**
 * Seis cestas desenhadas para o Apriori achar DUAS regras com o mesmo antecedente e
 * consequentes distintos (P1→P2 e P1→P3, lift 2.0 cada, contra minSupport 0.01/minLift 1.05).
 * Isso importa: o motor só monta bundle combinando DUAS regras aplicáveis (`relatedRules`),
 * então um cliente com uma regra só não produz linha — e o teste passaria por vacuidade.
 * `c7` comprou apenas P1: as duas regras se aplicam a ele e o par P2+P3 vira bundle.
 */
const PEDIDOS = [
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-01T00:00:00Z' },
  { customer_user_id: 'c9', items: [{ product_id: 'P1' }, { product_id: 'P2' }, { product_id: 'P3' }], total: 300, created_at: '2026-07-02T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-03T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-04T00:00:00Z' },
  { customer_user_id: 'c8', items: [{ product_id: 'P4' }], total: 50, created_at: '2026-07-05T00:00:00Z' },
  { customer_user_id: 'c7', items: [{ product_id: 'P1' }], total: 100, created_at: '2026-07-06T00:00:00Z' },
];
const PRODUTOS = ['P1', 'P2', 'P3', 'P4'].map((id) => ({
  id, codigo: id, descricao: `Produto ${id}`, valor_unitario: 100,
  metadata: null, ativo: true, omie_codigo_produto: null,
}));

const score = (cid: string, health: number) => ({
  customer_user_id: cid, farmer_id: FARMER, health_score: health, answer_rate_60d: 60,
  whatsapp_reply_rate_60d: 60, avg_monthly_spend_180d: 1000, gross_margin_pct: 30,
  category_count: 2, days_since_last_purchase: 10,
});
const perfil = (cid: string) => ({ user_id: cid, name: `Cliente ${cid}`, customer_type: 'moveleiro', cnae: '3101' });

function dadosDa(tabela: string): unknown[] {
  switch (tabela) {
    case 'farmer_client_scores': return [score('c9', 80), score('c8', 70), score('c7', 75)];
    case 'omie_products': return PRODUTOS;
    case 'profiles': return ['c9', 'c8', 'c7'].map(perfil);
    case 'sales_orders': return PEDIDOS;
    default: return [];
  }
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'eq', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve({ data: dadosDa(table), error: null, count: 0 });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
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
      // Paginada desde o #1782 — builder com `.order().range()`, não Promise crua.
      if (nome === 'get_skus_margem_positiva') {
        const chain: Record<string, unknown> = {
          order: () => chain,
          range: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: PRODUTOS.map((p) => ({ product_id: p.id })), error: null }),
        };
        return chain;
      }
      if (nome === 'farmer_geracao_registrar') {
        registros.push(args ?? {});
        return Promise.resolve({ data: null, error: null });
      }
      // A persistência REJEITA — o caso do achado: linhas calculadas, nada commitado.
      if (nome === 'farmer_bundle_recomendacoes_substituir' && falharGravacao) {
        return Promise.reject(new Error('connection failure'));
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => { falharGravacao = true; registros.length = 0; vi.clearAllMocks(); });

describe('useBundleEngine — head não mente após produzir linhas', () => {
  it('NÃO registra vazio quando a gravação falha depois de calcular bundles', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    // Pré-condição: o cenário precisa MESMO ter produzido bundles, senão o teste passa
    // por vacuidade e não guarda nada.
    expect(result.current.customerBundles.length).toBeGreaterThan(0);

    const vazios = registros.filter((r) => r.p_resultado === 'vazio');
    expect(vazios).toEqual([]);
  });
});
