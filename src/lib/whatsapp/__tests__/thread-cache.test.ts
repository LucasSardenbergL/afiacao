import { describe, it, expect } from 'vitest';
import {
  appendRealtimeMessage,
  montarMensagemOtimista,
  isOptimisticMessage,
} from '@/lib/whatsapp/thread-cache';
import type { WaMessage } from '@/queries/useWhatsappInbox';

const msg = (id: string, over: Partial<WaMessage> = {}): WaMessage => ({
  id,
  conversation_id: 'c1',
  direction: 'in',
  type: 'text',
  body: 'oi',
  status: null,
  created_at: '2026-06-10T12:00:00Z',
  wa_timestamp: null,
  ...over,
});

describe('appendRealtimeMessage (cache da thread)', () => {
  it('cache ausente → não cria (deixa o fetch popular)', () => {
    expect(appendRealtimeMessage(undefined, msg('m1'))).toBeUndefined();
  });

  it('append simples de mensagem inbound', () => {
    const out = appendRealtimeMessage([msg('m1')], msg('m2', { body: 'tudo bem?' }));
    expect(out?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('dedupe por id: replay do realtime não duplica balão', () => {
    const old = [msg('m1')];
    const out = appendRealtimeMessage(old, msg('m1'));
    expect(out).toBe(old); // referência inalterada — sem re-render
  });

  it('OUT substitui a 1ª otimista de MESMO body (sem balão duplicado)', () => {
    const otimista = montarMensagemOtimista('c1', 'já te respondo', '2026-06-10T12:01:00Z');
    const old = [msg('m1'), otimista];
    const real = msg('m2', { direction: 'out', body: 'já te respondo' });
    const out = appendRealtimeMessage(old, real);
    expect(out?.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out?.some(isOptimisticMessage)).toBe(false);
  });

  it('OUT com body diferente NÃO remove otimista alheia (envios concorrentes)', () => {
    const otimista = montarMensagemOtimista('c1', 'mensagem A', '2026-06-10T12:01:00Z');
    const real = msg('m2', { direction: 'out', body: 'mensagem B' });
    const out = appendRealtimeMessage([otimista], real);
    expect(out?.length).toBe(2);
    expect(out?.some(isOptimisticMessage)).toBe(true);
  });

  it('IN nunca remove otimista (só OUT reconcilia)', () => {
    const otimista = montarMensagemOtimista('c1', 'oi', '2026-06-10T12:01:00Z');
    const out = appendRealtimeMessage([otimista], msg('m9', { direction: 'in', body: 'oi' }));
    expect(out?.length).toBe(2);
  });
});

describe('montarMensagemOtimista', () => {
  it('gera mensagem OUT com prefixo otimista e body/status corretos', () => {
    const m = montarMensagemOtimista('c1', 'olá', '2026-06-10T12:00:00Z');
    expect(isOptimisticMessage(m)).toBe(true);
    expect(m.direction).toBe('out');
    expect(m.body).toBe('olá');
    expect(m.status).toBe('enviando');
    expect(m.conversation_id).toBe('c1');
  });
});
