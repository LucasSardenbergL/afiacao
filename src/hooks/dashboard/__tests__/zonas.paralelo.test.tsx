import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// As leituras independentes de cada zona da home staff saem JUNTAS (plano v4, lote 10 — C2 fatia 2).
//
// Como se prova: o supabase de mentira SEGURA toda resposta até o teste soltar. Com as leituras em
// série, a 2ª só começa depois que a 1ª responde — então, com tudo segurado, só UMA aparece como
// iniciada e o `waitFor` estoura. Em paralelo, todas aparecem antes de qualquer resposta.
//
// E a falha segue honesta com a resposta chegando em QUALQUER ordem: quem lançava lança com a mesma
// mensagem do ramo, quem degradava por bloco degrada só o seu KPI.

type Resposta = { data: unknown; error: unknown; count?: number | null };
type Pendente = { rotulo: string; soltar: (r: Resposta) => void };

let iniciadas: string[] = [];
let pendentes: Pendente[] = [];

// Rótulo = tabela (ou rpc) + colunas do select (+ severidade, que distingue as 3 leituras do topo
// de alertas). É o que separa duas leituras da MESMA tabela, ex.: as duas de `profiles` da Sistema.
function chain(alvo: string): unknown {
  let rotulo = alvo;
  const c: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(c, {
    get(_t, prop: string | symbol) {
      if (prop === 'then') {
        return (resolve: (v: Resposta) => void) => {
          iniciadas.push(rotulo);
          pendentes.push({ rotulo, soltar: resolve });
        };
      }
      return (...args: unknown[]) => {
        if (prop === 'select') rotulo = `${alvo}:${String(args[0])}`;
        if (prop === 'eq' && args[0] === 'severidade') rotulo += `:${String(args[1])}`;
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), rpc: (fn: string) => chain(`rpc ${fn}`) },
}));
vi.mock('@/hooks/useDashboardCompany', () => ({
  useDashboardCompany: () => ({ companies: ['oben'], mode: 'single', primary: 'oben' }),
}));
vi.mock('@/hooks/dashboard/useCockpitChannel', () => ({ useCockpitChannel: () => ({ isLive: false }) }));
vi.mock('@/contexts/DashboardPersonaContext', () => ({ useDashboardPersonaContext: () => ({ persona: 'master' }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import { useSistemaZone } from '../useSistemaZone';
import { useVendasZone } from '../useVendasZone';
import { useEstoqueZone } from '../useEstoqueZone';
import { useReposicaoZone } from '../useReposicaoZone';
import { useFinanceiroZone } from '../useFinanceiroZone';

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };
const VAZIA: Resposta = { data: [], error: null, count: 0 };

function montar<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(hook, { wrapper });
}

/** Solta a leitura pendente com este rótulo EXATO (exatamente uma). */
function soltar(rotulo: string, r: Resposta) {
  const achadas = pendentes.filter((p) => p.rotulo === rotulo);
  expect(achadas.map((p) => p.rotulo), `pendente "${rotulo}"`).toHaveLength(1);
  pendentes = pendentes.filter((p) => p !== achadas[0]);
  act(() => achadas[0].soltar(r));
}

/** Solta tudo o que estiver pendente — inclusive leituras que só nascem depois de outra (em série). */
async function soltarTudo(resposta: (rotulo: string) => Resposta = () => VAZIA) {
  for (let i = 0; i < 20 && pendentes.length > 0; i++) {
    const lote = pendentes;
    pendentes = [];
    await act(async () => {
      for (const p of lote) p.soltar(resposta(p.rotulo));
    });
  }
}

beforeEach(() => {
  iniciadas = [];
  pendentes = [];
});

describe('zonas da home — leituras independentes saem juntas', () => {
  const casos: Array<{ zona: string; hook: () => { isLoading: boolean }; esperadas: string[] }> = [
    {
      zona: 'Sistema',
      hook: useSistemaZone,
      esperadas: ['profiles:user_id, name, created_at', 'profiles:user_id', 'orders:created_at', 'sales_orders:created_at'],
    },
    {
      zona: 'Vendas',
      hook: useVendasZone,
      esperadas: ['sales_orders:total, status, order_date_kpi', 'orders:id', 'orders:id, total, status, created_at, user_id'],
    },
    {
      zona: 'Estoque',
      hook: useEstoqueZone,
      esperadas: [
        'nfe_recebimentos:id, razao_social_emitente, created_at, status',
        'picking_tasks:id',
        'picking_task_items:id, product_descricao, validade_fefo',
        'nfe_recebimentos:id',
      ],
    },
    {
      zona: 'Reposição',
      hook: useReposicaoZone,
      esperadas: [
        'pedido_compra_sugerido:id',
        'eventos_outlier:id',
        'eventos_outlier:id, tipo, sku_descricao, severidade:critico',
        'fornecedor_aumento_anunciado:id',
      ],
    },
    {
      zona: 'Financeiro',
      hook: useFinanceiroZone,
      esperadas: [
        'fin_aging_receber:*',
        'fin_contas_receber:nome_cliente, cnpj_cpf, saldo',
        'rpc fin_projecao_13_semanas',
        'fin_confiabilidade:pct_valor_mapeado, pct_mov_conciliado, fechamento_status',
      ],
    },
  ];

  for (const { zona, hook, esperadas } of casos) {
    it(`${zona}: todas as leituras independentes iniciam antes de qualquer uma responder`, async () => {
      const { result } = montar(hook);
      await waitFor(() => {
        for (const e of esperadas) expect(iniciadas, `iniciou "${e}"`).toContain(e);
      });
      // Nada respondeu ainda: o paralelismo não veio de uma resposta que destravou a próxima.
      expect(result.current.isLoading).toBe(true);
      await soltarTudo();
      await waitFor(() => expect(result.current.isLoading).toBe(false));
    });
  }
});

describe('zonas da home — a falha segue honesta em qualquer ordem de chegada', () => {
  it('Vendas: vendas do dia falha PRIMEIRO (as outras ainda no ar) → erro com a mensagem do ramo', async () => {
    const { result } = montar(useVendasZone);
    await waitFor(() => expect(pendentes).toHaveLength(3));
    soltar('sales_orders:total, status, order_date_kpi', { data: null, error: ERRO_PG });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.kpis).toEqual([]);
    await soltarTudo();
  });

  it('Vendas: vendas do dia falha POR ÚLTIMO (as outras já leram) → mesmo erro, sem R$ 0', async () => {
    const { result } = montar(useVendasZone);
    await waitFor(() => expect(pendentes).toHaveLength(3));
    soltar('orders:id, total, status, created_at, user_id', VAZIA);
    soltar('orders:id', { data: null, error: null, count: 4 });
    expect(result.current.isError).toBe(false);
    soltar('sales_orders:total, status, order_date_kpi', { data: null, error: null });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.kpis).toEqual([]);
  });

  it('Vendas: a rejeição carrega a mensagem do ramo (erro devolvido ≠ malformada)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    renderHook(useVendasZone, { wrapper });
    await waitFor(() => expect(pendentes).toHaveLength(3));
    soltar('sales_orders:total, status, order_date_kpi', { data: null, error: ERRO_PG });
    await waitFor(() => {
      const q = qc.getQueryCache().findAll({ queryKey: ['dashboard', 'vendas'] })[0];
      expect((q?.state.error as Error | null)?.message).toBe('sales_orders (vendas do dia): canceling statement due to statement timeout');
    });
    await soltarTudo();
  });

  it('Sistema: staff falha ANTES de as aprovações responderem → só o KPI de staff cai, com a mensagem dele', async () => {
    const { result } = montar(useSistemaZone);
    await waitFor(() => expect(pendentes).toHaveLength(4));
    soltar('profiles:user_id', { data: null, count: null, error: ERRO_PG });
    soltar('orders:created_at', { data: null, error: null });
    soltar('sales_orders:created_at', { data: null, error: null });
    soltar('profiles:user_id, name, created_at', {
      data: [{ user_id: 'u1', name: 'Ana', created_at: '2026-10-01' }],
      count: 1,
      error: null,
    });
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.erroStaff).toBe('profiles (staff ativos): canceling statement due to statement timeout');
    expect(result.current.kpis.find((k) => k.label === 'Staff ativos')?.value).toBe('—');
    expect(result.current.erroAprovacoes).toBeNull();
    expect(result.current.kpis.find((k) => k.label === 'Aprovações')?.value).toBe('1');
    expect(result.current.topItems.map((t) => t.title)).toEqual(['Ana']);
    expect(result.current.isError).toBe(false);
  });

  it('Estoque: FEFO respondendo antes das NFs não inverte o topo (NF segue primeiro)', async () => {
    const { result } = montar(useEstoqueZone);
    await waitFor(() => expect(pendentes).toHaveLength(4));
    soltar('picking_task_items:id, product_descricao, validade_fefo', {
      data: [{ id: 'f1', product_descricao: 'Verniz PU', validade_fefo: '2026-11-03' }],
      error: null,
    });
    soltar('nfe_recebimentos:id, razao_social_emitente, created_at, status', {
      data: [{ id: 'n1', razao_social_emitente: 'Sayerlack', created_at: new Date().toISOString(), status: 'pendente' }],
      error: null,
    });
    await soltarTudo();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.topItems.map((t) => t.id)).toEqual(['n1', 'f1']);
  });
});
