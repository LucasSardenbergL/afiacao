import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, maybeSingleMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  maybeSingleMock: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

import { resolveCustomerByPhone } from './resolve-customer';

beforeEach(() => {
  vi.clearAllMocks();
  // Mock chain: supabase.from().select().filter().maybeSingle()
  const chain = {
    select: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
  };
  fromMock.mockReturnValue(chain);
});

describe('resolveCustomerByPhone', () => {
  it('normaliza telefone pra dígitos só', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const result = await resolveCustomerByPhone('(31) 99999-1234');
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('retorna customerUserId quando encontra match', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { user_id: 'uuid-cliente-1' },
      error: null,
    });
    const result = await resolveCustomerByPhone('(31) 99999-1234');
    expect(result.customerUserId).toBe('uuid-cliente-1');
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('retorna customerUserId=null quando não encontra', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBeNull();
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('telefone vazio retorna ambos null/empty sem chamar supabase', async () => {
    const result = await resolveCustomerByPhone('');
    expect(result.customerUserId).toBeNull();
    expect(result.phoneDialed).toBe('');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('erro do supabase resulta em null silenciosamente', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error('rls denied') });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBeNull();
  });
});
