// src/lib/call-log/build-insert.test.ts
import { describe, it, expect } from 'vitest';
import { buildCallLogInsert } from './build-insert';

describe('buildCallLogInsert', () => {
  it('monta insert outbound manual sem cliente', () => {
    const row = buildCallLogInsert({
      farmerId: 'f1',
      direction: 'outbound',
      provider: 'nvoip_sip',
      phoneRaw: '(31) 3222-4040',
      party: { kind: 'desconhecido', customerUserId: null, matchConfidence: 'none', phoneNormalized: '3132224040' },
      recorded: false,
      callerIdUsed: '553735143571',
      sipCallId: 'abc123',
    });
    expect(row.farmer_id).toBe('f1');
    expect(row.direction).toBe('outbound');
    expect(row.status).toBe('ringing');
    expect(row.phone_normalized).toBe('3132224040');
    expect(row.phone_raw).toBe('(31) 3222-4040');
    expect(row.customer_user_id).toBeNull();
    expect(row.match_confidence).toBe('none');
    expect(row.recorded).toBe(false);
    expect(row.sip_call_id).toBe('abc123');
    expect(row.caller_id_used).toBe('553735143571');
    expect(row.source).toBe('app');
  });

  it('inbound de cliente identificado carrega customer + contato', () => {
    const row = buildCallLogInsert({
      farmerId: 'f1',
      direction: 'inbound',
      provider: 'nvoip_sip',
      phoneRaw: '37999998888',
      party: { kind: 'cliente', customerUserId: 'c1', matchConfidence: 'last8', phoneNormalized: '37999998888', contactName: 'João' },
      recorded: true,
      sipCallId: 'sip-9',
    });
    expect(row.direction).toBe('inbound');
    expect(row.customer_user_id).toBe('c1');
    expect(row.match_confidence).toBe('last8');
    expect(row.display_name).toBe('João');
    expect(row.recorded).toBe(true);
  });
});
