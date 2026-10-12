import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/useOfflineFlush', () => ({
  registerOfflineHandler: vi.fn(() => () => {}),
}));
vi.mock('@/services/recebimento-confirm', () => ({ confirmUnit: vi.fn() }));
vi.mock('@/services/recebimento-divergencia', () => ({ reportDivergencia: vi.fn() }));
vi.mock('@/services/recebimento-cte', () => ({ addCte: vi.fn() }));
vi.mock('@/services/picking-confirm', () => ({ confirmPickItem: vi.fn() }));
vi.mock('@/services/pcp-apontamento', () => ({ despacharApontamento: vi.fn() }));

import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { registerAllOfflineHandlers } from '../offline-handlers';

const mockedRegister = vi.mocked(registerOfflineHandler);

beforeEach(() => mockedRegister.mockClear());

describe('registerAllOfflineHandlers', () => {
  it('registra os 5 kinds offline (PCP no boot, não só com a tela aberta)', () => {
    registerAllOfflineHandlers();
    const kinds = mockedRegister.mock.calls.map((c) => c[0]);
    expect(kinds).toEqual(expect.arrayContaining([
      'recebimento.confirm-unit',
      'recebimento.report-divergencia',
      'recebimento.add-cte',
      'picking.confirm-item',
      'pcp.apontar',
    ]));
    expect(mockedRegister).toHaveBeenCalledTimes(5);
  });

  it('a cleanup desregistra todos', () => {
    const unregs = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let i = 0;
    mockedRegister.mockImplementation(() => unregs[i++]);
    const cleanup = registerAllOfflineHandlers();
    cleanup();
    unregs.forEach((u) => expect(u).toHaveBeenCalledTimes(1));
  });
});

describe('handlers usam o cliente do DONO, não o singleton', () => {
  it('cada handler repassa o `cliente` recebido do flush ao service', async () => {
    const { confirmUnit } = await import('@/services/recebimento-confirm');
    const { reportDivergencia } = await import('@/services/recebimento-divergencia');
    const { addCte } = await import('@/services/recebimento-cte');
    const { confirmPickItem } = await import('@/services/picking-confirm');
    const { despacharApontamento } = await import('@/services/pcp-apontamento');
    const services: Record<string, ReturnType<typeof vi.fn>> = {
      'recebimento.confirm-unit': vi.mocked(confirmUnit),
      'recebimento.report-divergencia': vi.mocked(reportDivergencia),
      'recebimento.add-cte': vi.mocked(addCte),
      'picking.confirm-item': vi.mocked(confirmPickItem),
      'pcp.apontar': vi.mocked(despacharApontamento),
    };
    mockedRegister.mockImplementation(() => () => {});
    registerAllOfflineHandlers();
    const cliente = { tag: 'cliente-do-dono' };
    for (const [kind, handler] of mockedRegister.mock.calls as unknown as [string, (v: unknown, c: unknown) => Promise<boolean>][]) {
      await handler({ kind }, cliente);
      expect(services[kind]).toHaveBeenLastCalledWith({ kind }, cliente);
    }
  });
});
