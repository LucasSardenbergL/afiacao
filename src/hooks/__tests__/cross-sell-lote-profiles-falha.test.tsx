import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard money-path — leitura que FALHA não pode virar carteira PARCIAL persistida.
 *
 * O supabase-js NÃO rejeita em erro de banco: resolve `{ data: null, error }`. Dois sítios do
 * motor tinham um cast que declarava só `{ data }` e APAGAVA o `error` do tipo:
 *
 *   · o lote de `profiles` (`.in('user_id', batch)`, 100 por lote, em `Promise.all`) seguido de
 *     `batchResults.flatMap((r) => r.data || [])` — um lote que falhasse virava `[]`, os
 *     clientes DAQUELE lote sumiam (`if (!profile) continue`) e o subconjunto restante era
 *     gravado em `farmer_recommendations` como se fosse a carteira inteira;
 *   · `farmer_association_rules` — regra faltando = recomendação mais pobre, sem sinal.
 *
 * O código foi fechado no #1606 (lote → `throw`) e no #1857 (regras via `fetchAllPages`), mas
 * o #1606 entrou SEM teste: nada impedia o `flatMap` tolerante de voltar. Achado [P1] do
 * challenge retroativo do #1550 (gêmeo do que o #1550 fechou nos paginadores).
 *
 * DISCRIMINADOR, em duas partes:
 *   1. nenhuma RECOMENDAÇÃO é gravada. Escrita detectada por FORMA (qualquer `.rpc()` além das
 *      conhecidas, qualquer insert/upsert/update/delete), não por nome — renomear a RPC de
 *      persistência não pode deixar este guard verde por cegueira;
 *   2. a única escrita tolerada é o HEAD da execução (`farmer_geracao_registrar`, que o
 *      `catch` move de propósito para um head `completo` antigo não seguir valendo) — e ele
 *      NUNCA pode sair `completo`. Falha registrada como `completo` + 0 linhas é o "zero de
 *      verdade" fabricado: a única licença que autoriza a fase 2 a EXPIRAR recomendações.
 *
 * Por que DOIS lotes e o 2º falhando: com um lote só, "falhou" e "não há clientes" se
 * confundem. Com dois, o lote 1 sozinho produz uma carteira plausível — é exatamente o
 * resultado parcial que o defeito gravava. O DETECTOR prova que esse caminho grava.
 */
const FARMER = 'farmer-real';
const N_CLIENTES = 150; // > 100 ⇒ 2 lotes de profiles
const clienteId = (i: number) => `c${String(i).padStart(3, '0')}`;
const CLIENTES = Array.from({ length: N_CLIENTES }, (_, i) => clienteId(i));
/** Primeiro cliente do 2º lote — a presença dele no `.in()` identifica o lote 2. */
const SENTINELA_LOTE_2 = clienteId(100);

type Escrita = { via: string; alvo: string; args?: Record<string, unknown> };
let escritas: Escrita[] = [];
let falharLote2 = false;
let falharRegras = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
const METODOS_DE_ESCRITA = new Set(['insert', 'upsert', 'update', 'delete']);
const RPC_DE_LEITURA = 'get_skus_margem_positiva';
const RPC_DO_HEAD = 'farmer_geracao_registrar';

// Seed: todo cliente comprou p1 e tem a regra p1→p2 ⇒ cada um recebe p2 como cross-sell.
const SCORES = CLIENTES.map((id) => ({
  customer_user_id: id, farmer_id: FARMER,
  health_score: 80, answer_rate_60d: 50, whatsapp_reply_rate_60d: 50,
}));
const PRODUTOS = [
  { id: 'p1', codigo: 'P1', descricao: 'Produto Um', valor_unitario: 100, metadata: null, ativo: true, omie_codigo_produto: 1, estoque: 10 },
  { id: 'p2', codigo: 'P2', descricao: 'Produto Dois', valor_unitario: 200, metadata: null, ativo: true, omie_codigo_produto: 2, estoque: 5 },
];
const PEDIDOS = CLIENTES.map((id) => ({
  customer_user_id: id, total: 200, created_at: '2026-07-01T00:00:00Z',
  items: [{ product_id: 'p1', quantity: 2, unit_price: 100 }],
}));
const REGRAS = [{
  antecedent_product_ids: ['p1'], consequent_product_ids: ['p2'],
  confidence: 0.5, lift: 2, support: 0.1,
}];
const perfis = (ids: string[]) =>
  ids.map((id) => ({ user_id: id, name: `Cliente ${id}`, customer_type: 'pj', cnae: null }));

type Q = { table: string; inValores: unknown[] };

function resposta(q: Q): unknown {
  switch (q.table) {
    case 'farmer_client_scores': return { data: SCORES, error: null, count: SCORES.length };
    case 'omie_products': return { data: PRODUTOS, error: null };
    case 'sales_orders': return { data: PEDIDOS, error: null };
    case 'farmer_association_rules':
      return falharRegras ? { data: null, error: ERRO_TIMEOUT } : { data: REGRAS, error: null };
    case 'profiles': {
      const ids = q.inValores as string[];
      if (falharLote2 && ids.includes(SENTINELA_LOTE_2)) return { data: null, error: ERRO_TIMEOUT };
      return { data: perfis(ids), error: null };
    }
    default: return { data: [], error: null, count: 0 };
  }
}

function chain(table: string): unknown {
  const q: Q = { table, inValores: [] };
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ]) c[m] = () => c;
  for (const m of METODOS_DE_ESCRITA) c[m] = () => { escritas.push({ via: m, alvo: table }); return c; };
  c.in = (_col: string, valores: unknown[]) => { q.inValores = valores; return c; };
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(q));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (nome: string, args?: Record<string, unknown>) => {
      if (nome !== RPC_DE_LEITURA) escritas.push({ via: 'rpc', alvo: nome, args });
      const r =
        nome === RPC_DE_LEITURA
          ? { data: [{ product_id: 'p1' }, { product_id: 'p2' }], error: null }
          : { data: null, error: null };
      const c: Record<string, unknown> = {
        order: () => c,
        range: () => c,
        then: (resolve: (v: unknown) => void) => resolve(r),
      };
      return c;
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: FARMER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: FARMER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { useCrossSellEngine } from '../useCrossSellEngine';

beforeEach(() => { escritas = []; falharLote2 = false; falharRegras = false; vi.clearAllMocks(); });

/** Tudo que grava fora do head da execução — no caminho de falha, tem que ser nada. */
const escritasDeRecomendacao = () => escritas.filter((e) => e.alvo !== RPC_DO_HEAD);
const headsRegistrados = () => escritas.filter((e) => e.alvo === RPC_DO_HEAD);

async function calcular() {
  const hook = renderHook(() => useCrossSellEngine());
  await act(async () => { await hook.result.current.calculateRecommendations(); });
  return hook.result;
}

describe('useCrossSellEngine — leitura que falha não grava carteira parcial', () => {
  it('DETECTOR: com tudo lido, os 2 lotes viram recomendação E o motor grava', async () => {
    // Sem isto "não gravou nada" passaria de graça: é o desfecho trivial de uma fixture
    // que não sabe recomendar, ou de um detector de escrita que não enxerga a persistência.
    const result = await calcular();

    expect(result.current.erro, 'a fixture feliz falhou').toBeNull();
    expect(result.current.recommendations, 'algum lote de clientes sumiu da fixture').toHaveLength(N_CLIENTES);
    expect(
      escritasDeRecomendacao().length,
      'o caminho feliz não gravou recomendação — o detector de escrita está cego',
    ).toBeGreaterThan(0);
  });

  it('lote 2 de profiles com `error` ⇒ NÃO grava, mesmo com o lote 1 íntegro', async () => {
    falharLote2 = true;
    const result = await calcular();

    expect(escritasDeRecomendacao(), 'gravou a carteira parcial (só o lote 1)').toEqual([]);
    expect(headsRegistrados().length, 'a falha não moveu o head — fica valendo o anterior').toBe(1);
    expect(headsRegistrados()[0].args?.p_completude, 'falha rotulada como zero de verdade').toBe('degradado');
    expect(result.current.recommendations, 'exibiu o subconjunto como se fosse a carteira').toHaveLength(0);
    expect(String(result.current.erro?.message ?? ''), 'a falha não identifica o lote').toContain(
      'lote 2/2 de profiles falhou',
    );
  });

  it('`farmer_association_rules` com `error` ⇒ NÃO grava recomendação sem as regras', async () => {
    falharRegras = true;
    const result = await calcular();

    expect(escritasDeRecomendacao(), 'gravou recomendação calculada sem as regras de associação').toEqual([]);
    expect(headsRegistrados().length).toBe(1);
    expect(headsRegistrados()[0].args?.p_completude, 'falha rotulada como zero de verdade').toBe('degradado');
    expect(result.current.recommendations).toHaveLength(0);
    // A mensagem vem da CAUSA (o servidor), não do jargão do helper de paginação.
    expect(String(result.current.erro?.message ?? '')).toContain('statement timeout');
  });
});
