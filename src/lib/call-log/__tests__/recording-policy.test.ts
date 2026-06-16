import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/call-session/resolve-customer', () => ({
  resolveCustomerByPhone: vi.fn(),
}));

import { shouldAutoRecord, resolveCallParty } from '../recording-policy';
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';

const mockResolve = vi.mocked(resolveCustomerByPhone);

beforeEach(() => vi.clearAllMocks());

describe('shouldAutoRecord (guard LGPD)', () => {
  it('cliente e fornecedor → auto-grava (toca o aviso de consentimento)', () => {
    expect(shouldAutoRecord('cliente')).toBe(true);
    expect(shouldAutoRecord('fornecedor')).toBe(true);
  });

  it('desconhecido → NÃO auto-grava (não grava número não-cadastrado)', () => {
    expect(shouldAutoRecord('desconhecido')).toBe(false);
  });
});

describe('resolveCallParty', () => {
  it('número cadastrado → cliente, mapeia contato, matchConfidence last8', async () => {
    mockResolve.mockResolvedValue({
      customerUserId: 'user-1',
      phoneDialed: '37999998888',
      contactName: 'João',
      contactCargo: 'Comprador',
    });
    const r = await resolveCallParty('(37) 99999-8888');
    expect(r).toEqual({
      kind: 'cliente',
      customerUserId: 'user-1',
      contactName: 'João',
      contactCargo: 'Comprador',
      matchConfidence: 'last8',
      phoneNormalized: '37999998888',
    });
  });

  it('sem match → desconhecido, sem userId, matchConfidence none, mas preserva o telefone', async () => {
    mockResolve.mockResolvedValue({ customerUserId: null, phoneDialed: '37999998888' });
    const r = await resolveCallParty('(37) 99999-8888');
    expect(r).toEqual({
      kind: 'desconhecido',
      customerUserId: null,
      matchConfidence: 'none',
      phoneNormalized: '37999998888',
    });
  });

  it('encadeia com shouldAutoRecord: cadastrado grava, desconhecido não', async () => {
    mockResolve.mockResolvedValueOnce({ customerUserId: 'u1', phoneDialed: '111' });
    const cliente = await resolveCallParty('111');
    expect(shouldAutoRecord(cliente.kind)).toBe(true);

    mockResolve.mockResolvedValueOnce({ customerUserId: null, phoneDialed: '222' });
    const desconhecido = await resolveCallParty('222');
    expect(shouldAutoRecord(desconhecido.kind)).toBe(false);
  });
});
