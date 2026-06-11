import { describe, it, expect } from 'vitest';
import { ehGateMinimoFaturamento } from '../shared';

// Detecta o pedido preso ESPECIFICAMENTE pelo gate de mínimo de faturamento Sayerlack
// (falha_envio + resposta_canal.gate==='minimo_faturamento'). É o único estado em que o
// botão "Disparar mesmo assim" (override) faz sentido — uma falha por OUTRO motivo (SKU
// sem custo etc.) NÃO deve oferecer override (não adianta, e mascararia o erro real).
describe('ehGateMinimoFaturamento', () => {
  it('true quando falha_envio + gate=minimo_faturamento', () => {
    expect(
      ehGateMinimoFaturamento({
        status: 'falha_envio',
        resposta_canal: { erro: 'abaixo do mínimo', gate: 'minimo_faturamento' },
      }),
    ).toBe(true);
  });

  it('false quando falha_envio por OUTRO motivo (sem gate)', () => {
    expect(
      ehGateMinimoFaturamento({
        status: 'falha_envio',
        resposta_canal: { erro: 'SKU(s) sem custo (preço unitário 0)' },
      }),
    ).toBe(false);
  });

  it('false quando o gate é outro valor', () => {
    expect(
      ehGateMinimoFaturamento({
        status: 'falha_envio',
        resposta_canal: { gate: 'outro_qualquer' },
      }),
    ).toBe(false);
  });

  it('false quando não é falha_envio (mesmo com o gate marcado)', () => {
    expect(
      ehGateMinimoFaturamento({
        status: 'aprovado_aguardando_disparo',
        resposta_canal: { gate: 'minimo_faturamento' },
      }),
    ).toBe(false);
  });

  it('false quando resposta_canal é null', () => {
    expect(ehGateMinimoFaturamento({ status: 'falha_envio', resposta_canal: null })).toBe(false);
  });
});
