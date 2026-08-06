import { describe, it, expect } from 'vitest';
import { whatsappPendenteParaAcoes, mapPendenteRows, type WaPendente } from '../adapters/whatsappPendente';

function pend(p: Partial<WaPendente>): WaPendente {
  return { conversationId: 'conv1', clienteUserId: 'c1', nome: 'Cliente 1', telefone: '5599', horasDesde: 2, ...p };
}

describe('whatsappPendenteParaAcoes', () => {
  it('mapeia para categoria prazo, cta whatsapp, sem valor', () => {
    const [a] = whatsappPendenteParaAcoes([pend({})]);
    expect(a.fonte).toBe('whatsapp_pendente');
    expect(a.categoria).toBe('prazo');
    expect(a.cta).toBe('whatsapp');
    expect(a.valorEsperado).toBeNull();
    expect(a.dedupeKey).toBe('c1:whatsapp');
    expect(a.payload).toEqual({ kind: 'whatsapp', conversationId: 'conv1' });
  });

  it('score cresce ao se aproximar das 24h', () => {
    const [novo] = whatsappPendenteParaAcoes([pend({ horasDesde: 2 })]);
    const [velho] = whatsappPendenteParaAcoes([pend({ horasDesde: 20 })]);
    expect(velho.score).toBeGreaterThan(novo.score);
  });

  it('sem clienteUserId usa conversationId no dedupeKey', () => {
    const [a] = whatsappPendenteParaAcoes([pend({ clienteUserId: null, conversationId: 'conv9' })]);
    expect(a.dedupeKey).toBe('conv9:whatsapp');
  });
});

describe('mapPendenteRows (rows da RPC get_whatsapp_pendentes → WaPendente)', () => {
  const AGORA = Date.parse('2026-07-13T12:00:00Z');
  const row = (over: Record<string, unknown> = {}) => ({
    conversation_id: 'conv1',
    customer_user_id: 'c1',
    contact_name: 'Cliente 1',
    phone_e164: '5537999990000',
    last_inbound_at: '2026-07-13T10:00:00Z', // 2h atrás
    ...over,
  });

  it('mapeia snake_case → WaPendente e computa horasDesde no relógio dado', () => {
    const [p] = mapPendenteRows([row()], AGORA);
    expect(p).toEqual({
      conversationId: 'conv1',
      clienteUserId: 'c1',
      nome: 'Cliente 1',
      telefone: '5537999990000',
      horasDesde: 2,
    });
  });

  it('descarta linha sem conversation_id ou com last_inbound_at inválido', () => {
    const rows = [row({ conversation_id: '' }), row({ last_inbound_at: 'não-é-data' }), row()];
    expect(mapPendenteRows(rows, AGORA)).toHaveLength(1);
  });

  it('clock skew (inbound "no futuro") não produz horasDesde negativo', () => {
    const [p] = mapPendenteRows([row({ last_inbound_at: '2026-07-13T12:05:00Z' })], AGORA);
    expect(p.horasDesde).toBe(0);
  });

  it('resposta não-array (erro de shape da RPC) vira lista vazia, não crash', () => {
    expect(mapPendenteRows(null, AGORA)).toEqual([]);
    expect(mapPendenteRows({ rows: [] }, AGORA)).toEqual([]);
  });
});
