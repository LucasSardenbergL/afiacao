import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Hardening TOCTOU money-path — mutations `cancelarEnvio` e `cancelarPedido` (#1152).
 *
 * As duas mutations faziam SELECT do guard e depois UPDATEs sem re-condicionar o
 * status. Se um envio 'agendado' vira 'enviado' no meio (cron 06h BRT ou "Enviar
 * agora" concorrente), o cancelamento devolvia itens de envio JÁ ENVIADO ao pool —
 * re-agendados viram envio novo → sales_order novo → chave PV_ nova → pedido
 * DUPLICADO real no Omie (a idempotência não cruza sales_orders).
 *
 * Contrato provado aqui (compare-and-set via PostgREST):
 * - cancelarEnvio: UPDATE condicionado (.in status agendado/erro) + .select('id')
 *   ANTES de desanexar itens; 0 linhas = aborta sem desanexar.
 * - cancelarPedido: CAS dos envios agendados → confere retornados === esperados →
 *   re-SELECT (envio novo criado no meio aborta) → CAS do header (ativo/erro_extracao)
 *   → desanexo por ÚLTIMO. Abort pós-CAS desanexa só o que NÓS cancelamos (limpeza).
 * - invalidação em onSettled: abort no meio já mutou estado → precisa refetch.
 */

interface Op {
  table: string;
  method: 'select' | 'update' | 'insert' | 'upsert';
  payload?: Record<string, unknown>;
  filters: Array<[op: string, col: string, val: unknown]>;
  selected: string | null;
  single: boolean;
}

let ops: Op[] = [];
let respond: (op: Op) => { data: unknown; error: unknown };

function chain(table: string): unknown {
  const op: Op = { table, method: 'select', filters: [], selected: null, single: false };
  const c: Record<string, unknown> = {};
  c.select = (cols?: string) => { if (op.method === 'select') op.selected = cols ?? '*'; else op.selected = cols ?? '*'; return c; };
  c.update = (payload: Record<string, unknown>) => { op.method = 'update'; op.payload = payload; return c; };
  c.insert = (payload: Record<string, unknown>) => { op.method = 'insert'; op.payload = payload; return c; };
  c.upsert = (payload: Record<string, unknown>) => { op.method = 'upsert'; op.payload = payload; return c; };
  for (const f of ['eq', 'neq', 'in', 'is', 'not', 'lte', 'gte']) {
    c[f] = (col: string, ...val: unknown[]) => { op.filters.push([f, col, val.length === 1 ? val[0] : val]); return c; };
  }
  c.order = () => c;
  c.limit = () => c;
  c.single = () => { op.single = true; return c; };
  c.maybeSingle = () => { op.single = true; return c; };
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    // registra na SEQUÊNCIA global só quando a query é de fato awaited
    ops.push(op);
    try { return Promise.resolve(resolve(respond(op))); } catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e); }
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'staff-1' } } }) },
    functions: { invoke: vi.fn() },
    storage: { from: () => ({ upload: vi.fn() }) },
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { usePedidosProgramadosMutations } from '../usePedidosProgramados';

const PEDIDO = 'pedido-1';
const ENVIO_A = 'envio-a';
const ENVIO_B = 'envio-b';

let qc: QueryClient;
let invalidateSpy: MockInstance;

function setup() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => usePedidosProgramadosMutations(PEDIDO), { wrapper });
}

// ── helpers de leitura da sequência gravada ──
const isDetachItens = (o: Op) =>
  o.table === 'pedidos_programados_itens' && o.method === 'update' && o.payload?.envio_id === null;
const isCasEnvio = (o: Op) =>
  o.table === 'pedidos_programados_envios' && o.method === 'update' && o.payload?.status === 'cancelado';
const isCasHeader = (o: Op) =>
  o.table === 'pedidos_programados' && o.method === 'update' && o.payload?.status === 'cancelado';
const filtro = (o: Op, op: string, col: string) => o.filters.find(([f, c]) => f === op && c === col)?.[2];

beforeEach(() => {
  ops = [];
  vi.clearAllMocks();
});

describe('cancelarEnvio — CAS antes do desanexo (corrida agendado→enviado)', () => {
  it('aborta SEM desanexar itens quando o CAS retorna 0 linhas (envio mudou de estado)', async () => {
    respond = (op) => {
      if (op.table === 'pedidos_programados_envios' && op.method === 'select') {
        return { data: { sales_orders_map: {} }, error: null };
      }
      // CAS do envio: virou 'enviado' no meio → 0 linhas
      if (isCasEnvio(op)) return { data: [], error: null };
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.cancelarEnvio.mutateAsync(ENVIO_A)).rejects.toThrow(/mudou de estado/i);
    });
    expect(ops.some(isDetachItens)).toBe(false); // NUNCA desanexa sem o CAS confirmar
  });

  it('caminho feliz: CAS condicionado (in status agendado/erro + select) roda ANTES do desanexo', async () => {
    respond = (op) => {
      if (op.table === 'pedidos_programados_envios' && op.method === 'select') {
        return { data: { sales_orders_map: {} }, error: null };
      }
      if (isCasEnvio(op)) return { data: [{ id: ENVIO_A }], error: null };
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => { await result.current.cancelarEnvio.mutateAsync(ENVIO_A); });

    const iCas = ops.findIndex(isCasEnvio);
    const iDetach = ops.findIndex(isDetachItens);
    expect(iCas).toBeGreaterThanOrEqual(0);
    expect(iDetach).toBeGreaterThan(iCas); // ordem invertida vs. código antigo
    const cas = ops[iCas];
    expect(filtro(cas, 'eq', 'id')).toBe(ENVIO_A);
    expect(filtro(cas, 'in', 'status')).toEqual(['agendado', 'erro']);
    expect(cas.selected).toBeTruthy(); // .select('id') — sem representation não há como contar linhas
    expect(filtro(ops[iDetach], 'in', 'envio_id')).toEqual([ENVIO_A]); // desanexa exatamente os itens do envio cancelado
  });

  it('guard money-path preservado: envio com PV real no Omie bloqueia sem NENHUMA escrita', async () => {
    respond = (op) => {
      if (op.table === 'pedidos_programados_envios' && op.method === 'select') {
        return { data: { sales_orders_map: { oben: 'so-1' } }, error: null };
      }
      if (op.table === 'sales_orders') {
        return { data: [{ id: 'so-1', account: 'oben', omie_numero_pedido: 123, omie_pedido_id: 999 }], error: null };
      }
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.cancelarEnvio.mutateAsync(ENVIO_A)).rejects.toThrow(/Omie/);
    });
    expect(ops.some((o) => o.method === 'update')).toBe(false);
  });

  it('abort pós-guard invalida as queries mesmo assim (onSettled) — o estado remoto pode ter mudado', async () => {
    respond = (op) => {
      if (op.table === 'pedidos_programados_envios' && op.method === 'select') {
        return { data: { sales_orders_map: {} }, error: null };
      }
      if (isCasEnvio(op)) return { data: [], error: null }; // abort
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.cancelarEnvio.mutateAsync(ENVIO_A)).rejects.toThrow();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pedidos-programados'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['pedido-programado', PEDIDO] });
  });
});

describe('cancelarPedido — CAS dos envios + re-SELECT + CAS do header, desanexo por último', () => {
  const guardSelect = (o: Op) =>
    o.table === 'pedidos_programados_envios' && o.method === 'select' && !o.filters.some(([f]) => f === 'in');
  const reSelect = (o: Op) =>
    o.table === 'pedidos_programados_envios' && o.method === 'select' && o.filters.some(([f, c]) => f === 'in' && c === 'status');

  it('corrida R1: CAS retorna menos envios que o esperado → aborta, header intacto, desanexa SÓ os cancelados por nós', async () => {
    respond = (op) => {
      if (guardSelect(op)) {
        return { data: [{ id: ENVIO_A, status: 'agendado' }, { id: ENVIO_B, status: 'agendado' }], error: null };
      }
      if (isCasEnvio(op)) return { data: [{ id: ENVIO_A }], error: null }; // B virou 'enviado' no meio
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.cancelarPedido.mutateAsync()).rejects.toThrow(/mudou de estado/i);
    });
    expect(ops.some(isCasHeader)).toBe(false); // header NÃO pode ser cancelado
    const detaches = ops.filter(isDetachItens);
    expect(detaches).toHaveLength(1); // limpeza: só o que NÓS cancelamos
    expect(filtro(detaches[0], 'in', 'envio_id')).toEqual([ENVIO_A]);
  });

  it('CAS dos envios é condicionado a status=agendado e pede representation (.select)', async () => {
    respond = (op) => {
      if (guardSelect(op)) return { data: [{ id: ENVIO_A, status: 'agendado' }], error: null };
      if (isCasEnvio(op)) return { data: [{ id: ENVIO_A }], error: null };
      if (reSelect(op)) return { data: [], error: null };
      if (isCasHeader(op)) return { data: [{ id: PEDIDO }], error: null };
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => { await result.current.cancelarPedido.mutateAsync(); });
    const cas = ops.find(isCasEnvio)!;
    expect(filtro(cas, 'in', 'id')).toEqual([ENVIO_A]);
    expect(filtro(cas, 'eq', 'status')).toBe('agendado');
    expect(cas.selected).toBeTruthy();
  });

  it('envio NOVO criado durante o cancelamento (re-SELECT) → aborta antes do header', async () => {
    respond = (op) => {
      if (guardSelect(op)) return { data: [{ id: ENVIO_A, status: 'agendado' }], error: null };
      if (isCasEnvio(op)) return { data: [{ id: ENVIO_A }], error: null };
      if (reSelect(op)) return { data: [{ id: 'envio-novo' }], error: null }; // staff concorrente criou envio
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.cancelarPedido.mutateAsync()).rejects.toThrow(/envio/i);
    });
    expect(ops.some(isCasHeader)).toBe(false);
  });

  it('header: CAS condicionado a ativo/erro_extracao com .select — virou concluido no meio → aborta', async () => {
    respond = (op) => {
      if (guardSelect(op)) return { data: [], error: null }; // sem envios
      if (reSelect(op)) return { data: [], error: null };
      if (isCasHeader(op)) return { data: [], error: null }; // header mudou (ex.: concluido)
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.cancelarPedido.mutateAsync()).rejects.toThrow(/pedido mudou/i);
    });
    const cas = ops.find(isCasHeader)!;
    expect(filtro(cas, 'eq', 'id')).toBe(PEDIDO);
    expect(filtro(cas, 'in', 'status')).toEqual(['ativo', 'erro_extracao']);
    expect(cas.selected).toBeTruthy();
  });

  it('caminho feliz: desanexo dos itens acontece DEPOIS do CAS do header (janela de pool mínima)', async () => {
    respond = (op) => {
      if (guardSelect(op)) {
        return { data: [{ id: ENVIO_A, status: 'agendado' }, { id: ENVIO_B, status: 'agendado' }], error: null };
      }
      if (isCasEnvio(op)) return { data: [{ id: ENVIO_A }, { id: ENVIO_B }], error: null };
      if (reSelect(op)) return { data: [], error: null };
      if (isCasHeader(op)) return { data: [{ id: PEDIDO }], error: null };
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => { await result.current.cancelarPedido.mutateAsync(); });

    const iHeader = ops.findIndex(isCasHeader);
    const iDetach = ops.findIndex(isDetachItens);
    expect(iHeader).toBeGreaterThanOrEqual(0);
    expect(iDetach).toBeGreaterThan(iHeader);
    expect(filtro(ops[iDetach], 'in', 'envio_id')).toEqual([ENVIO_A, ENVIO_B]);
  });

  it('guard de envio enviado/erro preservado: bloqueia tudo sem escrita', async () => {
    respond = (op) => {
      if (guardSelect(op)) {
        return { data: [{ id: ENVIO_A, status: 'enviado' }, { id: ENVIO_B, status: 'agendado' }], error: null };
      }
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => {
      await expect(result.current.cancelarPedido.mutateAsync()).rejects.toThrow(/enviado/);
    });
    expect(ops.some((o) => o.method === 'update')).toBe(false);
  });

  it('pedido sem envios: cancela o header direto (CAS) e não toca itens de envio nenhum', async () => {
    respond = (op) => {
      if (guardSelect(op)) return { data: [], error: null };
      if (reSelect(op)) return { data: [], error: null };
      if (isCasHeader(op)) return { data: [{ id: PEDIDO }], error: null };
      return { data: [], error: null };
    };
    const { result } = setup();
    await act(async () => { await result.current.cancelarPedido.mutateAsync(); });
    expect(ops.some(isCasEnvio)).toBe(false);
    expect(ops.some(isDetachItens)).toBe(false);
    expect(ops.some(isCasHeader)).toBe(true);
  });
});

describe('enviarAgora — corrida: envio some da fila do edge (cancelado/enviado por outra via)', () => {
  it('resultados vazio do edge NÃO vira toast de sucesso — lança erro claro', async () => {
    const { supabase } = await import('@/integrations/supabase/client');
    (supabase.functions.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { success: true, processados: 0, resultados: [] },
      error: null,
    });
    respond = () => ({ data: [], error: null });
    const { result } = setup();
    await act(async () => {
      await expect(result.current.enviarAgora.mutateAsync(ENVIO_A)).rejects.toThrow(/recarregue/i);
    });
  });
});
