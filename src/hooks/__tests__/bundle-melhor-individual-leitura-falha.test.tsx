import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { toast } from 'sonner';

/**
 * Guard money-path — a leitura do "melhor individual" não pode virar nem um zero fabricado
 * nem um head `vazio/completo`.
 *
 * O motor lê o melhor individual da carteira e monta a comparação "bundle × melhor produto
 * individual". A leitura era um `.from('farmer_recommendations')` POR CLIENTE, dentro do laço,
 * e hoje é a RPC em bloco `farmer_melhor_individual_por_cliente` — a PORTA mudou, os dois
 * defeitos abaixo são os mesmos e continuam sendo o que este arquivo guarda. O `error` era
 * DESCARTADO na desestruturação (`const { data: existingRecs } = await ...`), e daí saíam dois
 * defeitos de gravidade bem diferente:
 *
 *  1. `{ data: null, error }` resolvido — a falha vira "não há recomendação pendente":
 *     `bestIndividual` fica `null`, o cliente sem bundle próprio é OMITIDO da lista inteira, e
 *     ao fim a execução ainda emite `toast.success`. É o §2 (ausente ≠ zero) na forma de
 *     rótulo: uma leitura que não aconteceu apresentada como veredicto.
 *
 *  2. A Promise REJEITADA (rede/CORS) é pior, e é o achado do challenge Codex (gpt-5.6-sol,
 *     xhigh): a exceção escapa do laço para o `catch` externo. Nesse ponto TODOS os insumos
 *     obrigatórios já foram declarados íntegros (são lidos antes do laço) e `linhasProduzidas`
 *     ainda é `false` — então `registrarVazio()` grava `resultado='vazio'` com
 *     `completude='completo'`. Esse par é a licença exata que a fase 2 usaria para EXPIRAR a
 *     carteira de ofertas da vendedora. Mesmo defeito que o #1791 fechou, por outra porta.
 *
 * DISCRIMINADOR: nenhum registro de head `vazio` + `completo` nascido desta leitura, e nenhum
 * `toast.success` quando ela falhou.
 *
 * ⚠️ Com a leitura em BLOCO a falha deixou de ser por-cliente: é UMA, e vale para a execução
 * inteira. Isso não afrouxa nada aqui — o que estes testes julgam é o DESFECHO da execução
 * (head, toast, bundles na tela), e ele é o mesmo. O que a leitura em bloco acrescenta está no
 * irmão `bundle-melhor-individual-bulk.test.tsx`: os três estados chegam à UI e nenhum cliente
 * é omitido em silêncio.
 */
const FARMER = 'farmer-real';

/** 'nao' | 'erro' (resolvido) | 'rejeita' (Promise rejeitada). */
let falhaMelhorIndividual: 'nao' | 'erro' | 'rejeita' = 'nao';

const registros: Array<Record<string, unknown>> = [];

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

/**
 * Mesmo seed de `bundle-head-nao-mente-apos-linhas.test.tsx`: seis cestas que fazem o Apriori
 * achar DUAS regras com o mesmo antecedente (P1→P2 e P1→P3), e `c7` — que comprou só P1 —
 * receber o par P2+P3 como bundle. Sem isso o teste passaria por vacuidade.
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
      // Paginada desde o #1782 — builder com `.order().range()`, não Promise crua.
      if (nome === 'get_skus_margem_positiva') {
        const c: Record<string, unknown> = {
          order: () => c,
          range: () => c,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: PRODUTOS.map((p) => ({ product_id: p.id })), error: null }),
        };
        return c;
      }
      // A leitura do melhor individual — UMA tupla jsonb. As duas falhas entram por aqui.
      if (nome === 'farmer_melhor_individual_por_cliente') {
        // A REJEIÇÃO é o caminho perigoso: escapa para o `catch` externo com todos os
        // insumos obrigatórios já íntegros. O `{ error }` resolvido é o silencioso.
        if (falhaMelhorIndividual === 'rejeita') return Promise.reject(new Error('Failed to fetch'));
        if (falhaMelhorIndividual === 'erro') return Promise.resolve({ data: null, error: ERRO_TIMEOUT });
        return Promise.resolve({ data: [], error: null });
      }
      if (nome === 'farmer_geracao_registrar') {
        registros.push(args ?? {});
        return Promise.resolve({ data: null, error: null });
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

beforeEach(() => {
  falhaMelhorIndividual = 'nao';
  registros.length = 0;
  vi.clearAllMocks();
});

describe('useBundleEngine — a leitura do melhor individual não fabrica zero nem head completo', () => {
  it('DETECTOR: o caminho feliz produz bundles e anuncia sucesso', async () => {
    // Sem isto, "não achei o toast de sucesso" e "o cenário nunca produziu bundle" seriam
    // indistinguíveis, e as asserções abaixo passariam por vacuidade.
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(result.current.customerBundles.length).toBeGreaterThan(0);
    expect(toast.success).toHaveBeenCalled();
  });

  it('a Promise REJEITADA não vira head "vazio/completo"', async () => {
    falhaMelhorIndividual = 'rejeita';

    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    const licenca = registros.filter(
      (r) => r.p_resultado === 'vazio' && r.p_completude === 'completo',
    );
    expect(
      licenca,
      'gravou a licença exata para a fase 2 expirar a carteira por uma falha de leitura',
    ).toEqual([]);
  });

  it('a falha não é apresentada como sucesso', async () => {
    falhaMelhorIndividual = 'erro';

    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(
      toast.success,
      'anunciou sucesso com uma leitura que falhou — o operador vai embora achando que está tudo lido',
    ).not.toHaveBeenCalled();
  });

  it('a falha NÃO aborta os bundles já descobertos', async () => {
    // Precisão > recall não é fail-closed cego: a comparação individual é acessória e não
    // entra no payload da RPC de substituição, então derrubar a carteira inteira por causa
    // dela trocaria uma mentira por um prejuízo maior.
    falhaMelhorIndividual = 'erro';

    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    expect(
      result.current.customerBundles.length,
      'a falha de um insumo acessório levou junto os bundles válidos',
    ).toBeGreaterThan(0);
  });
});
