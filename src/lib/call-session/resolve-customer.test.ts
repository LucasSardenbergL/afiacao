import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: rpcMock },
}));

import { resolveCustomerByPhone } from './resolve-customer';

function linha(over: Partial<Record<string, unknown>> = {}) {
  return {
    customer_user_id: 'uuid-1',
    contato_nome: null,
    contato_cargo: null,
    fonte: 'perfil',
    candidatos: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveCustomerByPhone', () => {
  it('manda à RPC só os dígitos do número discado', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const result = await resolveCustomerByPhone('(31) 99999-1234');
    expect(rpcMock).toHaveBeenCalledWith('resolver_cliente_por_telefone', { p_telefone: '31999991234' });
    expect(result.phoneDialed).toBe('31999991234');
  });

  it('menos de 8 dígitos: desconhecido sem ir ao banco', async () => {
    for (const raw of ['', '1234', '(31) 9']) {
      const result = await resolveCustomerByPhone(raw);
      expect(result).toMatchObject({ customerUserId: null, reconhecido: false, candidatos: 0 });
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('dono único pelo perfil', async () => {
    rpcMock.mockResolvedValue({ data: [linha({ customer_user_id: 'uuid-2' })], error: null });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result).toMatchObject({ customerUserId: 'uuid-2', reconhecido: true, candidatos: 1 });
    expect(result.contactName).toBeUndefined();
    expect(result.contactCargo).toBeUndefined();
  });

  it('dono pelo contato traz nome e cargo', async () => {
    rpcMock.mockResolvedValue({
      data: [linha({ fonte: 'contato', contato_nome: 'João Silva', contato_cargo: 'gerente' })],
      error: null,
    });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result).toMatchObject({
      customerUserId: 'uuid-1', reconhecido: true, contactName: 'João Silva', contactCargo: 'gerente',
    });
  });

  it('telefone de vários clientes sem dono único: reconhecido, mas sem customerUserId', async () => {
    rpcMock.mockResolvedValue({ data: [linha({ customer_user_id: null, candidatos: 3 })], error: null });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result).toMatchObject({ customerUserId: null, reconhecido: true, candidatos: 3 });
  });

  it('nenhum dono (zero linhas): desconhecido', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result).toMatchObject({ customerUserId: null, reconhecido: false, candidatos: 0, phoneDialed: '31999991234' });
  });

  it('falha da RPC degrada para desconhecido e loga a MENSAGEM (não [object Object])', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: null, error: { message: 'function resolver_cliente_por_telefone does not exist', code: 'PGRST202' } });
    const result = await resolveCustomerByPhone('31999991234');
    expect(result).toMatchObject({ customerUserId: null, reconhecido: false });
    const logado = consoleSpy.mock.calls.flat().join(' ');
    expect(logado).toContain('does not exist');
    expect(logado).not.toContain('[object Object]');
    consoleSpy.mockRestore();
  });

  it('exceção de transporte degrada para desconhecido sem derrubar a ligação', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpcMock.mockRejectedValue(new Error('Failed to fetch'));
    const result = await resolveCustomerByPhone('31999991234');
    expect(result).toMatchObject({ customerUserId: null, reconhecido: false });
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('Failed to fetch');
    consoleSpy.mockRestore();
  });
});
