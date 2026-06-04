import { describe, it, expect } from 'vitest';
import { whatsappPendenteParaAcoes, type WaPendente } from '../adapters/whatsappPendente';

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
