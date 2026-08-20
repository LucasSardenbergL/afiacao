import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — o OUTRO lado do `bundle-head-nao-mente-apos-linhas`: quando o cálculo
 * NÃO produziu linha persistível, o `catch` PRECISA registrar o vazio.
 *
 * O que ele guarda (correção do #1800): `linhasProduzidas` conta LINHAS, não clientes.
 *
 *     linhasProduzidas = allCustomerBundles.some((cb) => cb.bundles.length > 0)
 *
 * Um cliente entra em `allCustomerBundles` com `bundles: []` quando só tem `bestIndividual`
 * — e essa comparação não vira linha nenhuma no `p_linhas` da RPC de substituição. Contando
 * CLIENTES (`allCustomerBundles.length > 0`, como era antes), esse caso travava o
 * `registrarVazio()` do `catch` sobre uma execução que não produziu nada: o head parava de se
 * mover e "nenhum registro novo" voltava a significar duas coisas opostas — o defeito que o
 * #1765 e o #1791 fecharam por outros ângulos.
 *
 * ⚠️ **O GATILHO DESTE TESTE É SINTÉTICO, e isso é declarado de propósito.** `linhasProduzidas`
 * só tem efeito observável em UMA linha — o `if (!linhasProduzidas) await registrarVazio()` do
 * `catch` —, então o cenário exige uma exceção lançada DEPOIS de `linhasProduzidas` ser
 * calculado. Auditado no código de hoje, esse trecho não tem de onde lançar: o `flatMap` roda
 * sobre `bundles: []`, `avaliarCompletude` é pura, e `registrarGeracaoFarmer` é blindada em
 * todas as camadas (`supabase.rpc` em try/catch, `mensagemDeErro` sem `JSON.stringify`,
 * `captureException` embrulhado por `withPosthog`). Sobra a cauda do `try` — o toast —, e é
 * ele que este teste faz lançar. O invariante, porém, é real e é do BANCO, não do toast:
 * *execução sem linha persistível tem que mover o head*. O dia em que alguém acrescentar um
 * `await` nessa janela (um sensor, uma segunda gravação, um `track()` assíncrono), o caminho
 * reabre — e o guard já está aqui. Análise completa em
 * `docs/historico/farmer-bundle-linhas-produzidas.md`.
 *
 * DISCRIMINADOR: com `.length > 0` (clientes) o head NÃO registra o vazio; com `.some(...)`
 * (linhas) ele registra. Falsificado nos dois locales — ver o doc.
 */
const FARMER = 'farmer-real';

/** Registros que a RPC do sensor de fato ACEITOU — não as tentativas. */
const gravados: Array<Record<string, unknown>> = [];
let tentativasRegistro = 0;

/**
 * As mesmas seis cestas do irmão `bundle-head-nao-mente-apos-linhas`: o Apriori acha
 * P1→P2 e P1→P3 (lift 2.0 contra minSupport 0.01/minLift 1.05). A diferença é a CARTEIRA —
 * `c7`, o único cliente a quem as duas regras se aplicariam, fica de fora dela. As regras
 * seguem sendo descobertas (`regras` é insumo OBRIGATÓRIO do bundle: sem elas o snapshot
 * sairia degradado e o teste mediria outra coisa), e ninguém na carteira recebe bundle.
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
    // Sem `c7`: a carteira é só quem JÁ comprou tudo que as regras ofereceriam.
    case 'farmer_client_scores': return [score('c9', 80), score('c8', 70)];
    case 'omie_products': return PRODUTOS;
    case 'profiles': return ['c9', 'c8'].map(perfil);
    case 'sales_orders': return PEDIDOS;
    // O ingrediente do caso: com `bestIndividual` o cliente ENTRA em `allCustomerBundles`
    // mesmo com `topBundles` vazio (`if (topBundles.length > 0 || bestIndividual)`) — e é
    // exatamente esse cliente que a contagem antiga confundia com uma linha gravável.
    case 'farmer_recommendations':
      return [{ product_id: 'P4', affinity_score: 0.9, recommendation_type: 'cross_sell' }];
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
      if (nome === 'farmer_geracao_registrar') {
        tentativasRegistro += 1;
        // A 1ª tentativa (a do fluxo normal, com `recomendacoes.length === 0`) falha como
        // `falha_rpc` — que por DESENHO não trava o slot `jaRegistrou`, justamente para uma
        // 2ª tentativa poder dar certo. Sem isso o `catch` encontraria o slot travado e os
        // dois mundos (clientes vs. linhas) ficariam indistinguíveis.
        if (tentativasRegistro === 1) {
          return Promise.resolve({ data: null, error: { message: 'sensor fora do ar' } });
        }
        gravados.push(args ?? {});
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
// O gatilho SINTÉTICO — ver o ⚠️ do cabeçalho. Representa "uma falha qualquer na cauda do
// `try`, depois de `linhasProduzidas` ter sido decidido", que é a única forma de alcançar o
// `catch` neste cenário.
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(() => { throw new Error('falha na cauda do try'); }),
    warning: vi.fn(() => { throw new Error('falha na cauda do try'); }),
  },
}));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useBundleEngine } from '../useBundleEngine';

beforeEach(() => {
  gravados.length = 0;
  tentativasRegistro = 0;
  vi.clearAllMocks();
});

describe('useBundleEngine — head registra o vazio quando não houve linha', () => {
  it('FG-VAZIO-SEM-LINHA: cliente só com bestIndividual não conta como linha produzida', async () => {
    const { result } = renderHook(() => useBundleEngine());
    await act(async () => { await result.current.calculateBundles(); });

    // Pré-condições — sem elas o teste passaria por vacuidade e não guardaria nada:
    // a lista tem cliente (o que a contagem antiga lia como "produziu")...
    expect(result.current.customerBundles.length).toBeGreaterThan(0);
    // ...e NENHUM deles tem bundle (o que a RPC leria como zero linhas).
    expect(result.current.customerBundles.every((cb) => cb.bundles.length === 0)).toBe(true);
    // ...e o `catch` foi mesmo alcançado. Verdadeiro nos DOIS mundos (a exceção sobe de
    // qualquer jeito), então isto separa "o guard não agiu" de "o cenário não chegou lá".
    expect(result.current.erro).toBeTruthy();

    // O discriminador: o head SE MOVEU, declarando o vazio desta execução. Com a contagem
    // de CLIENTES, `linhasProduzidas` sai true e o `catch` nem tenta — zero registros.
    const vazios = gravados.filter((r) => r.p_resultado === 'vazio');
    expect(vazios.length).toBe(1);
    expect(vazios[0].p_linhas_geradas).toBe(0);
    // A 1ª tentativa é a do fluxo normal (que falhou), a 2ª é a do `catch`.
    expect(tentativasRegistro).toBe(2);
  });
});
