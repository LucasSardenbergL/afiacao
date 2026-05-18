import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: fromMock },
}));

import { resolveCustomerByPhone } from './resolve-customer';

interface MockChain {
  select: ReturnType<typeof vi.fn>;
  filter: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
}

function buildChain(resolveValue: { data: unknown; error: unknown }): MockChain {
  const chain: Partial<MockChain> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.filter = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(resolveValue);
  return chain as MockChain;
}

// Helper: configura mocks pra customer_contacts + profiles em sequência
function setupResolves(opts: {
  contact?: { data: unknown; error?: unknown };
  profile?: { data: unknown; error?: unknown };
}) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'customer_contacts') {
      return buildChain(opts.contact ?? { data: null, error: null });
    }
    if (table === 'profiles') {
      return buildChain(opts.profile ?? { data: null, error: null });
    }
    return buildChain({ data: null, error: null });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCustomerByPhone', () => {
  it('normaliza telefone pra dígitos só', async () => {
    setupResolves({ contact: { data: null }, profile: { data: null } });
    const result = await resolveCustomerByPhone('(31) 99999-1234');
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('telefone vazio retorna ambos null/empty sem chamar supabase', async () => {
    const result = await resolveCustomerByPhone('');
    expect(result.customerUserId).toBeNull();
    expect(result.phoneDialed).toBe('');
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('match em customer_contacts retorna contactName + contactCargo + customerUserId', async () => {
    setupResolves({
      contact: { data: { customer_user_id: 'uuid-1', nome: 'João Silva', cargo: 'gerente' } },
    });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBe('uuid-1');
    expect(result.contactName).toBe('João Silva');
    expect(result.contactCargo).toBe('gerente');
    // Não chamou profiles porque achou em contacts
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(fromMock).toHaveBeenCalledWith('customer_contacts');
  });

  it('sem match em contacts, fallback pra profiles retorna customerUserId sem contactName', async () => {
    setupResolves({
      contact: { data: null },
      profile: { data: { user_id: 'uuid-2' } },
    });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBe('uuid-2');
    expect(result.contactName).toBeUndefined();
    expect(result.contactCargo).toBeUndefined();
    expect(fromMock).toHaveBeenCalledTimes(2);
    expect(fromMock).toHaveBeenNthCalledWith(1, 'customer_contacts');
    expect(fromMock).toHaveBeenNthCalledWith(2, 'profiles');
  });

  it('sem match em nenhum lugar retorna null', async () => {
    setupResolves({ contact: { data: null }, profile: { data: null } });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBeNull();
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('erro em profiles resulta em null silenciosamente', async () => {
    setupResolves({
      contact: { data: null },
      profile: { data: null, error: new Error('rls denied') },
    });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result.customerUserId).toBeNull();
  });
});
