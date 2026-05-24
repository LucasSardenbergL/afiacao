import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/useOfflineFlush', () => ({
  registerOfflineHandler: vi.fn(() => () => {}),
}));
vi.mock('@/services/recebimento-confirm', () => ({ confirmUnit: vi.fn() }));
vi.mock('@/services/recebimento-divergencia', () => ({ reportDivergencia: vi.fn() }));
vi.mock('@/services/recebimento-cte', () => ({ addCte: vi.fn() }));
vi.mock('@/services/picking-confirm', () => ({ confirmPickItem: vi.fn() }));

import { registerOfflineHandler } from '@/hooks/useOfflineFlush';
import { registerAllOfflineHandlers } from '../offline-handlers';

const mockedRegister = vi.mocked(registerOfflineHandler);

beforeEach(() => mockedRegister.mockClear());

describe('registerAllOfflineHandlers', () => {
  it('registra os 4 kinds offline', () => {
    registerAllOfflineHandlers();
    const kinds = mockedRegister.mock.calls.map((c) => c[0]);
    expect(kinds).toEqual(expect.arrayContaining([
      'recebimento.confirm-unit',
      'recebimento.report-divergencia',
      'recebimento.add-cte',
      'picking.confirm-item',
    ]));
    expect(mockedRegister).toHaveBeenCalledTimes(4);
  });

  it('a cleanup desregistra todos', () => {
    const unregs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let i = 0;
    mockedRegister.mockImplementation(() => unregs[i++]);
    const cleanup = registerAllOfflineHandlers();
    cleanup();
    unregs.forEach((u) => expect(u).toHaveBeenCalledTimes(1));
  });
});
