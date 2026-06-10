import { describe, it, expect } from 'vitest';
import {
  appendRealtimeMessage,
  montarMensagemOtimista,
  isOptimisticMessage,
  prependOlderMessages,
  mergeThreadWindow,
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

describe('prependOlderMessages (carregar mensagens anteriores)', () => {
  it('prepend simples: página antiga entra ANTES do cache', () => {
    const old = [msg('m3'), msg('m4')];
    const { next, added } = prependOlderMessages(old, [msg('m1'), msg('m2')]);
    expect(next?.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(added).toBe(2);
  });

  it('dedupe por id: a duplicata do cursor (.lte re-baixa) é descartada', () => {
    const old = [msg('m2'), msg('m3')];
    const { next, added } = prependOlderMessages(old, [msg('m1'), msg('m2')]);
    expect(next?.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(added).toBe(1);
  });

  it('página só com duplicatas → added=0 e MESMA referência (sem re-render)', () => {
    const old = [msg('m1'), msg('m2')];
    const { next, added } = prependOlderMessages(old, [msg('m1'), msg('m2')]);
    expect(next).toBe(old);
    expect(added).toBe(0);
  });

  it('cache ausente → não cria (added=0)', () => {
    const { next, added } = prependOlderMessages(undefined, [msg('m1')]);
    expect(next).toBeUndefined();
    expect(added).toBe(0);
  });
});

describe('mergeThreadWindow (refetch não descarta histórico carregado)', () => {
  const t = (h: string) => `2026-06-10T${h}:00Z`;

  it('preserva mensagens antigas reais ANTES da janela fresca', () => {
    const prev = [
      msg('h1', { created_at: t('08:00') }),
      msg('h2', { created_at: t('09:00') }),
      msg('m3', { created_at: t('10:00') }),
    ];
    const janela = [
      msg('m3', { created_at: t('10:00') }),
      msg('m4', { created_at: t('11:00') }),
    ];
    expect(mergeThreadWindow(prev, janela).map((m) => m.id)).toEqual(['h1', 'h2', 'm3', 'm4']);
  });

  it('otimista órfã do cache anterior morre no refetch (comportamento de antes)', () => {
    const orfa = montarMensagemOtimista('c1', 'falhou?', t('09:30'));
    const prev = [msg('h1', { created_at: t('08:00') }), orfa];
    const janela = [msg('m3', { created_at: t('10:00') })];
    const out = mergeThreadWindow(prev, janela);
    expect(out.some(isOptimisticMessage)).toBe(false);
    expect(out.map((m) => m.id)).toEqual(['h1', 'm3']);
  });

  it('empate de timestamp na borda da janela não some (<= + dedupe)', () => {
    const prev = [msg('irma', { created_at: t('10:00') }), msg('m3', { created_at: t('10:00') })];
    const janela = [msg('m3', { created_at: t('10:00') }), msg('m4', { created_at: t('11:00') })];
    expect(mergeThreadWindow(prev, janela).map((m) => m.id)).toEqual(['irma', 'm3', 'm4']);
  });

  it('cache vazio/ausente → janela fresca', () => {
    const janela = [msg('m1')];
    expect(mergeThreadWindow(undefined, janela)).toBe(janela);
    expect(mergeThreadWindow([], janela)).toBe(janela);
  });

  it('janela vazia (servidor diz que não há nada) → vazio, não preserva stale', () => {
    expect(mergeThreadWindow([msg('h1')], [])).toEqual([]);
  });

  it('sufixo REAL mais novo que a janela é preservado (inbound do realtime durante o RTT do refetch)', () => {
    // O cliente respondeu DEPOIS do snapshot do SELECT: o append do realtime
    // está no cache mas não na janela — descartá-lo sumia com a mensagem.
    const prev = [
      msg('m3', { created_at: t('10:00') }),
      msg('inbound-rtt', { created_at: t('12:00') }),
    ];
    const janela = [msg('m3', { created_at: t('10:00') }), msg('m4', { created_at: t('11:00') })];
    expect(mergeThreadWindow(prev, janela).map((m) => m.id)).toEqual(['m3', 'm4', 'inbound-rtt']);
  });

  it('otimista mais nova que a janela NÃO entra no sufixo (continua morrendo no refetch)', () => {
    const orfa = montarMensagemOtimista('c1', 'em voo', t('12:00'));
    const prev = [msg('m3', { created_at: t('10:00') }), orfa];
    const janela = [msg('m3', { created_at: t('10:00') }), msg('m4', { created_at: t('11:00') })];
    expect(mergeThreadWindow(prev, janela).map((m) => m.id)).toEqual(['m3', 'm4']);
  });

  it('ANTI-BURACO: janela CHEIA sem nenhum overlap com o cache → descarta o cache (sem costura não-contígua)', () => {
    // Realtime morto perdeu >100 mensagens: cache [A1..] e janela [B...] sem
    // id em comum — costurar criaria buraco invisível no meio da conversa.
    const prev = Array.from({ length: 3 }, (_, i) => msg(`A${i}`, { created_at: t('08:00') }));
    const janela = Array.from({ length: 100 }, (_, i) =>
      msg(`B${i}`, { created_at: t('10:00') }));
    expect(mergeThreadWindow(prev, janela)).toBe(janela);
  });

  it('janela PARCIAL (alcança o início da conversa) sem overlap → merge normal preserva antigas', () => {
    const prev = [msg('h1', { created_at: t('08:00') })];
    const janela = [msg('m3', { created_at: t('10:00') })]; // 1 < THREAD_LIMIT
    expect(mergeThreadWindow(prev, janela).map((m) => m.id)).toEqual(['h1', 'm3']);
  });
});
