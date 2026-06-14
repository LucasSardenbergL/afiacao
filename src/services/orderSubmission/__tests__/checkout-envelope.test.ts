import { describe, it, expect } from 'vitest';
import { computeCheckoutFingerprint, decideCheckoutEnvelope } from '../checkout-envelope';

describe('computeCheckoutFingerprint', () => {
  const a = { account: 'oben', omie_codigo_produto: 1, quantity: 2, unit_price: 10 };
  const b = { account: 'colacor', omie_codigo_produto: 9, quantity: 1, unit_price: 5 };
  it('independe da ordem dos itens', () => {
    expect(computeCheckoutFingerprint('c1', [a, b])).toBe(computeCheckoutFingerprint('c1', [b, a]));
  });
  it('muda com quantidade e com cliente', () => {
    expect(computeCheckoutFingerprint('c1', [a])).not.toBe(computeCheckoutFingerprint('c1', [{ ...a, quantity: 3 }]));
    expect(computeCheckoutFingerprint('c1', [a])).not.toBe(computeCheckoutFingerprint('c2', [a]));
  });
});

describe('decideCheckoutEnvelope', () => {
  const env = (fp: string, committed: boolean) => ({ checkoutId: 'k', fingerprint: fp, committed });
  it('sem envelope → new', () => { expect(decideCheckoutEnvelope(null, 'fp')).toBe('new'); });
  it('mesma fp, não committed → reuse', () => { expect(decideCheckoutEnvelope(env('fp', false), 'fp')).toBe('reuse'); });
  it('mesma fp, committed → reuse (retry do mesmo envio)', () => { expect(decideCheckoutEnvelope(env('fp', true), 'fp')).toBe('reuse'); });
  it('fp diferente, não committed → new (pedido mudou antes de enviar)', () => { expect(decideCheckoutEnvelope(env('old', false), 'fp')).toBe('new'); });
  it('fp diferente, committed → conflict (envio pendente de outro carrinho)', () => { expect(decideCheckoutEnvelope(env('old', true), 'fp')).toBe('conflict'); });
  it('metadata da ponte (origem/atendimento) NÃO afeta a decisão — fp bate → reuse', () => {
    const withMeta = { checkoutId: 'k', fingerprint: 'fp', committed: false, customerUserId: 'cli-A', origem: 'ligacao_sainte', atendimentoId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' };
    expect(decideCheckoutEnvelope(withMeta, 'fp')).toBe('reuse');
  });
});
