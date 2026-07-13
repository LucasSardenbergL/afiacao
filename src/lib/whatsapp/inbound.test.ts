import { describe, it, expect } from 'vitest';
import { waPhoneCandidates, parseInboundWebhook, is24hWindowOpen, parseStatusWebhook, isStatusUpgrade } from './inbound';

describe('waPhoneCandidates', () => {
  it('normaliza E.164 do WhatsApp (móvel 13 dígitos) e gera variante sem o 9', () => {
    const c = waPhoneCandidates('5537998765432');
    expect(c).toContain('37998765432');
    expect(c).toContain('3798765432');
  });
  it('normaliza fixo (12 dígitos) sem inventar 9', () => {
    const c = waPhoneCandidates('553733334444');
    expect(c).toContain('3733334444');
    expect(c).not.toContain('37933334444');
  });
  it('aceita número já sem 55 e com máscara', () => {
    const c = waPhoneCandidates('(37) 99876-5432');
    expect(c).toContain('37998765432');
  });
  it('retorna vazio pra entrada inválida', () => {
    expect(waPhoneCandidates('')).toEqual([]);
    expect(waPhoneCandidates(null as unknown as string)).toEqual([]);
  });
});

describe('parseInboundWebhook', () => {
  const textPayload = {
    entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: 'Marcenaria Silva' }, wa_id: '5537998765432' }],
      messages: [{ from: '5537998765432', id: 'wamid.ABC', timestamp: '1716900000', type: 'text', text: { body: 'preciso de lixa 120' } }],
    } }] }],
  };
  it('extrai mensagem de texto com remetente, id, corpo, nome e timestamp', () => {
    const r = parseInboundWebhook(textPayload);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ waMessageId: 'wamid.ABC', fromPhone: '5537998765432', type: 'text', body: 'preciso de lixa 120', contactName: 'Marcenaria Silva' });
    expect(r[0].waTimestamp).toBeInstanceOf(Date);
  });
  it('extrai áudio com media_id e body nulo', () => {
    const p = { entry: [{ changes: [{ value: { messages: [{ from: '5537998765432', id: 'wamid.AUD', timestamp: '1716900001', type: 'audio', audio: { id: 'media-1' } }] } }] }] };
    const r = parseInboundWebhook(p);
    expect(r[0]).toMatchObject({ type: 'audio', mediaId: 'media-1', body: null });
  });
  it('retorna [] pra payload de status (sem messages)', () => {
    const status = { entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] } }] }] };
    expect(parseInboundWebhook(status)).toEqual([]);
  });
  it('retorna [] pra payload malformado/nulo', () => {
    expect(parseInboundWebhook(null)).toEqual([]);
    expect(parseInboundWebhook({})).toEqual([]);
    expect(parseInboundWebhook({ entry: [{}] })).toEqual([]);
  });
});

describe('is24hWindowOpen', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  it('aberta se última entrada do cliente < 24h', () => {
    expect(is24hWindowOpen(new Date('2026-05-28T10:00:00Z'), now)).toBe(true);
  });
  it('fechada se >= 24h', () => {
    expect(is24hWindowOpen(new Date('2026-05-27T14:59:00Z'), now)).toBe(false);
  });
  it('fechada se nunca houve entrada', () => {
    expect(is24hWindowOpen(null, now)).toBe(false);
  });
  it('aceita string ISO', () => {
    expect(is24hWindowOpen('2026-05-28T14:00:00Z', now)).toBe(true);
  });
});

// --- statuses do webhook (núcleo HSM) ---
describe('parseStatusWebhook', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                { id: 'wamid.A', status: 'delivered', timestamp: '1760000000', recipient_id: '5537999990000' },
                {
                  id: 'wamid.B',
                  status: 'failed',
                  timestamp: '1760000001',
                  errors: [{ code: 131047, title: 'Re-engagement message' }],
                },
              ],
            },
          },
        ],
      },
    ],
  };
  it('extrai id, status, erro e timestamp', () => {
    const out = parseStatusWebhook(payload);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ waMessageId: 'wamid.A', status: 'delivered', erro: null });
    expect(out[0].waTimestamp?.getTime()).toBe(1760000000 * 1000);
    expect(out[1]).toMatchObject({ waMessageId: 'wamid.B', status: 'failed' });
    expect(out[1].erro).toMatch(/131047/);
  });
  it('payload sem statuses → []', () => {
    expect(parseStatusWebhook({ entry: [{ changes: [{ value: { messages: [] } }] }] })).toEqual([]);
    expect(parseStatusWebhook(null)).toEqual([]);
  });
  it('status desconhecido é descartado (não inventa estado)', () => {
    const p = { entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'warmed_up' }] } }] }] };
    expect(parseStatusWebhook(p)).toEqual([]);
  });
});

describe('isStatusUpgrade', () => {
  it('progride sent→delivered→read e nunca regride (webhooks chegam fora de ordem)', () => {
    expect(isStatusUpgrade('sent', 'delivered')).toBe(true);
    expect(isStatusUpgrade('read', 'delivered')).toBe(false);
    expect(isStatusUpgrade('delivered', 'delivered')).toBe(false);
    expect(isStatusUpgrade(null, 'sent')).toBe(true);
    expect(isStatusUpgrade('queued', 'sent')).toBe(true);
  });
  it('failed é terminal e sempre vence', () => {
    expect(isStatusUpgrade('read', 'failed')).toBe(true);
    expect(isStatusUpgrade('failed', 'delivered')).toBe(false);
  });
});
