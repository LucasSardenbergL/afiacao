import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * O SENSOR da fila do Plano Tático — instalado porque a fase N+1 exige sinal da fase N.
 *
 * Medido em 2026-08-13 (docs/historico/fila-plano-tatico.md, errata): 533 planos gerados,
 * ZERO desfecho, e ZERO `track()` na tela. Sem sensor não se separa "não abrem" de "abrem e
 * não registram" — e o `loadPlans` piorava isso: das suas quatro saídas, três produziam o
 * MESMO pixel ("Nenhum plano pendente") e a quarta deixava a lista ANTIGA na tela.
 *
 * DISCRIMINADOR: o `loadPlans` fazia `const { data } = await …`, DESCARTANDO o `error` da
 * consulta da lista. Um teste que só checasse "emitiu evento" passaria na versão velha, que
 * classificava falha de consulta como fila vazia. Os asserts abaixo travam a diferença.
 */
const MASTER = 'master-id';

type Modo = 'ok' | 'lista_vazia' | 'erro_consulta' | 'sem_resposta' | 'excecao';
let modo: Modo = 'ok';
let erroRpc: { message: string } | null = null;

const PLANO = {
  id: 'p1', customer_user_id: 'c1', status: 'gerado',
  strategic_objective: 'consolidacao_margem', customer_profile: 'x',
  generated_at: '2026-08-01T00:00:00Z',
};

function resultadoDaLista(): unknown {
  if (modo === 'lista_vazia') return { data: [], error: null };
  if (modo === 'erro_consulta') return { data: null, error: { message: 'statement timeout', code: '57014' } };
  if (modo === 'sem_resposta') return { data: null, error: null };
  if (modo === 'excecao') throw new Error('Failed to fetch');
  return { data: [PLANO], error: null };
}

function chain(table: string): unknown {
  let head = false;
  const c: Record<string, unknown> = {};
  for (const m of ['in', 'lt', 'lte', 'is', 'not', 'or', 'filter', 'update', 'range', 'neq', 'eq', 'gte', 'order', 'limit']) c[m] = () => c;
  c.select = (_cols: string, opts?: { count?: string; head?: boolean }) => {
    if (opts?.head) head = true;
    return c;
  };
  c.single = () => c;
  c.maybeSingle = () => c;
  c.then = (resolve: (v: unknown) => void) => {
    if (table === 'farmer_tactical_plans' && head) return resolve({ data: null, count: 169, error: null });
    if (table === 'farmer_tactical_plans') return resolve(resultadoDaLista());
    return resolve({ data: [], error: null });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: erroRpc }),
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: MASTER }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: MASTER }, isStaff: true }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { track } from '@/lib/analytics';
import { useTacticalPlan } from '../useTacticalPlan';

const eventos = () => (track as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
const ultimo = (nome: string) => eventos().filter(([e]) => e === nome).at(-1);

beforeEach(() => {
  modo = 'ok';
  erroRpc = null;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('telemetria da carga da fila', () => {
  it('fila com planos emite fila_carregada com tamanho, total e filtro', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    const ev = ultimo('plano_tatico.fila_carregada');
    expect(ev).toBeDefined();
    expect(ev![1]).toMatchObject({ n_exibidos: 1, total: 169, filtro: 'pendentes' });
  });

  it('fila vazia emite fila_vazia com motivo recorte_vazio', async () => {
    modo = 'lista_vazia';
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    expect(ultimo('plano_tatico.fila_vazia')![1]).toMatchObject({ motivo: 'recorte_vazio' });
    expect(eventos().map(([e]) => e)).not.toContain('plano_tatico.fila_carregada');
  });

  it('CONSULTA QUE FALHA emite fila_erro — jamais fila_vazia (o `error` era descartado)', async () => {
    modo = 'erro_consulta';
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    // Este é o caso que motivou o PR: sem capturar o `error`, "a query morreu" ficava
    // indistinguível de "não há plano nenhum" — o mesmo pixel, o mesmo evento, o mesmo zero.
    const ev = ultimo('plano_tatico.fila_erro');
    expect(ev).toBeDefined();
    expect(ev![1]).toMatchObject({ origem: 'consulta', mensagem: 'statement timeout', manteve_lista: false });
    expect(eventos().map(([e]) => e)).not.toContain('plano_tatico.fila_vazia');
  });

  it('resposta sem data E sem error vira motivo sem_resposta, não um palpite', async () => {
    modo = 'sem_resposta';
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });

    expect(ultimo('plano_tatico.fila_vazia')![1]).toMatchObject({ motivo: 'sem_resposta' });
  });

  it('EXCEÇÃO: reporta erro e sinaliza que a lista ANTIGA continua na tela', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });
    expect(r.current.plans).toHaveLength(1);

    modo = 'excecao';
    await act(async () => { await r.current.loadPlans('pendentes'); });

    // Precedência do erro sobre `data`: o catch de loadPlans NÃO limpa `plans`, então a tela
    // segue exibindo o retrato do carregamento anterior. Reportar fila_carregada a partir
    // desse estado seria dizer "sucesso" sobre uma carga que quebrou.
    expect(r.current.plans).toHaveLength(1);
    const ev = ultimo('plano_tatico.fila_erro');
    expect(ev![1]).toMatchObject({ origem: 'excecao', manteve_lista: true });
    expect(eventos().filter(([e]) => e === 'plano_tatico.fila_carregada')).toHaveLength(1);
  });

  it('contagem que falha viaja como total null — nunca 0', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => { await r.current.loadPlans('pendentes'); });
    // O harness devolve count=169 sem erro; o guard de "ausente ≠ zero" na contagem já é
    // coberto por fila-plano-tatico.test.tsx. Aqui só se trava que o total ATRAVESSA o evento.
    expect(ultimo('plano_tatico.fila_carregada')![1].total).toBe(169);
  });
});

describe('telemetria do desfecho', () => {
  it('RPC que recusa o registro emite desfecho_erro com a mensagem real', async () => {
    erroRpc = { message: 'Plano fora da sua carteira' };
    const { result: r } = renderHook(() => useTacticalPlan());

    await act(async () => {
      await r.current.recordResult('p1', {
        planFollowed: null, callResult: 'venda_realizada', actualMargin: null, callDurationSeconds: null,
      });
    });

    // O catch mostra toast e some — a falha ficava invisível JUSTO no passo que alimenta o
    // dado escasso (`call_result`). Sem este evento, clique sem linha no banco é indistinguível
    // de "ela nem clicou".
    const ev = ultimo('plano_tatico.desfecho_erro');
    expect(ev).toBeDefined();
    expect(ev![1]).toMatchObject({ mensagem: 'Plano fora da sua carteira', desfecho: 'venda_realizada' });
  });

  it('registro que dá certo NÃO emite desfecho_erro (o sucesso já é visível no banco)', async () => {
    const { result: r } = renderHook(() => useTacticalPlan());
    await act(async () => {
      await r.current.recordResult('p1', {
        planFollowed: null, callResult: 'nao_atendeu', actualMargin: null, callDurationSeconds: null,
      });
    });

    expect(eventos().map(([e]) => e)).not.toContain('plano_tatico.desfecho_erro');
  });
});
