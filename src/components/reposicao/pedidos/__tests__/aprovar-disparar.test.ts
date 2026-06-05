import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import { aprovarEDisparar } from '../aprovar-disparar';

const mockedRpc = vi.mocked(supabase.rpc);
const mockedInvoke = vi.mocked(supabase.functions.invoke);

const params = { pedidoId: 130, empresa: 'OBEN', usuario: 'lucas@x.com' };

beforeEach(() => {
  mockedRpc.mockReset();
  mockedInvoke.mockReset();
});

describe('aprovarEDisparar', () => {
  it('happy path: RPC ok → invoca a edge → retorna o resultado interpretado (Omie)', async () => {
    mockedRpc.mockResolvedValue({ data: { ok: true }, error: null } as never);
    mockedInvoke.mockResolvedValue({ data: { disparados: 1 }, error: null } as never);

    const r = await aprovarEDisparar(params);

    // chamou o RPC com os args canônicos
    expect(mockedRpc).toHaveBeenCalledWith('aprovar_pedido_sugerido', {
      p_pedido_id: 130,
      p_usuario: 'lucas@x.com',
    });
    // chamou a edge com empresa + pedido_id
    expect(mockedInvoke).toHaveBeenCalledWith('disparar-pedidos-aprovados', {
      body: { empresa: 'OBEN', pedido_id: 130 },
    });
    // resultado interpretado (disparados>0 = Omie direto)
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('success');
    expect(r.mensagem).toContain('#130');
    expect(r.mensagem).toContain('Omie');
  });

  it('ordem: RPC é chamado ANTES da edge', async () => {
    const order: string[] = [];
    mockedRpc.mockImplementation((() => {
      order.push('rpc');
      return Promise.resolve({ data: null, error: null });
    }) as never);
    mockedInvoke.mockImplementation((() => {
      order.push('edge');
      return Promise.resolve({ data: { disparados: 1 }, error: null });
    }) as never);

    await aprovarEDisparar(params);
    expect(order).toEqual(['rpc', 'edge']);
  });

  it('erro de transporte do RPC (PostgREST error) → curto-circuito: NÃO invoca a edge, retorna erro', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: { message: 'rls negou' } } as never);

    const r = await aprovarEDisparar(params);

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.tipo).toBe('error');
    expect(r.mensagem).toContain('rls negou');
  });

  it('erro jsonb do RPC ({ error }) → curto-circuito: NÃO invoca a edge, retorna erro', async () => {
    mockedRpc.mockResolvedValue({ data: { error: 'pedido não está pendente' }, error: null } as never);

    const r = await aprovarEDisparar(params);

    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.tipo).toBe('error');
    expect(r.mensagem).toContain('pedido não está pendente');
  });

  it('falha do disparo (edge error): best-effort — aprovado, mas avisa (warning), NÃO lança', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);
    mockedInvoke.mockResolvedValue({ data: null, error: { message: 'edge 500' } } as never);

    const r = await aprovarEDisparar(params);

    // a aprovação valeu (RPC ok); o disparo é a rede de segurança do cron
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('warning');
    expect(r.mensagem.length).toBeGreaterThan(0);
  });

  it('falha SÍNCRONA do disparo (edge 200 com { disparados:0, falhas:1 }): aprovado, mas { ok:true, tipo:"error" }', async () => {
    // A edge respondeu 200 (sem error de transporte), mas o Omie rejeitou o disparo
    // (ex.: guard nValUnit<=0/nQtde<=0). O pedido aprovou; o disparo falhou de verdade.
    // O lote apura por `tipo` justamente p/ não contar isto como sucesso.
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);
    mockedInvoke.mockResolvedValue({ data: { disparados: 0, falhas: 1 }, error: null } as never);

    const r = await aprovarEDisparar(params);

    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('error');
    expect(r.mensagem).toContain('#130');
    expect(r.mensagem).toContain('falha');
  });

  it('disparo retorna portal Sayerlack em background → success "iniciado"', async () => {
    mockedRpc.mockResolvedValue({ data: null, error: null } as never);
    mockedInvoke.mockResolvedValue({ data: { aguardando_portal_sayerlack: 1 }, error: null } as never);

    const r = await aprovarEDisparar(params);
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('success');
    expect(r.mensagem).toContain('iniciado');
  });
});
