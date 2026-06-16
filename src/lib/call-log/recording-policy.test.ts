// src/lib/call-log/recording-policy.test.ts
import { describe, it, expect, vi } from 'vitest';
import { shouldAutoRecord } from './recording-policy';
import { resolveCallParty } from './recording-policy';

vi.mock('@/lib/call-session/resolve-customer', () => ({
  resolveCustomerByPhone: vi.fn(),
}));
import { resolveCustomerByPhone } from '@/lib/call-session/resolve-customer';

describe('shouldAutoRecord', () => {
  it('grava automaticamente para cliente', () => {
    expect(shouldAutoRecord('cliente')).toBe(true);
  });
  it('grava automaticamente para fornecedor (ramo dormente, mas pronto)', () => {
    expect(shouldAutoRecord('fornecedor')).toBe(true);
  });
  it('NÃO grava automaticamente para desconhecido/avulso', () => {
    expect(shouldAutoRecord('desconhecido')).toBe(false);
  });
});

describe('resolveCallParty', () => {
  it('cliente identificado → kind cliente + last8', async () => {
    vi.mocked(resolveCustomerByPhone).mockResolvedValue({
      customerUserId: 'u1', phoneDialed: '37999998888', contactName: 'João', contactCargo: 'comprador',
    });
    const r = await resolveCallParty('(37) 99999-8888');
    expect(r.kind).toBe('cliente');
    expect(r.customerUserId).toBe('u1');
    expect(r.contactName).toBe('João');
    expect(r.matchConfidence).toBe('last8');
  });

  it('não identificado → kind desconhecido + none', async () => {
    vi.mocked(resolveCustomerByPhone).mockResolvedValue({ customerUserId: null, phoneDialed: '1140028922' });
    const r = await resolveCallParty('11 4002-8922');
    expect(r.kind).toBe('desconhecido');
    expect(r.customerUserId).toBeNull();
    expect(r.matchConfidence).toBe('none');
  });
});
