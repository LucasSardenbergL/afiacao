import { describe, it, expect } from 'vitest';
import { decidirDescarteRascunho, decideCheckoutEnvelope, computeCheckoutFingerprint, type CheckoutEnvelope } from '../checkout-envelope';
import { carrinhoAposOrcamentoParcial } from '../submitQuote';

// Ciclo ÚNICO envelope × rascunho (follow-up Codex do #4042).
describe('decidirDescarteRascunho', () => {
  const fp = computeCheckoutFingerprint('c1', [{ account: 'colacor', omie_codigo_produto: 9, quantity: 1, unit_price: 5 }]);
  const pendente: CheckoutEnvelope = { checkoutId: 'k1', fingerprint: fp, committed: true, afiacaoOs: { assinatura: 'a', numero: '77' } };

  it('envelope pendente (envio parcial) → confirmar antes de descartar', () => {
    expect(decidirDescarteRascunho(pendente)).toBe('confirmar');
  });
  it('sem envelope → descarta direto (sem atrito no caso comum)', () => {
    expect(decidirDescarteRascunho(null)).toBe('descartar');
  });
  it('cenário do bug 1: se o envelope sobrevivesse ao descarte, o pedido idêntico sairia como reuse ("já enviado")', () => {
    // Prova o PORQUÊ de zerar o envelope no descarte: com ele vivo, o mesmo carrinho é 'reuse'.
    expect(decideCheckoutEnvelope(pendente, fp)).toBe('reuse');
    // Zerado (o que handleDiscardDraft faz após a confirmação) → 'new': o pedido novo é criado.
    expect(decideCheckoutEnvelope(null, fp)).toBe('new');
  });
});

describe('carrinhoAposOrcamentoParcial', () => {
  const cart = [
    { id: 'o1', type: 'product', account: 'oben' },
    { id: 'c1', type: 'product', account: 'colacor' },
    { id: 's1', type: 'service', account: undefined },
  ];
  it('tira só as linhas da conta gravada; pendente e serviço ficam', () => {
    expect(carrinhoAposOrcamentoParcial(cart, ['colacor']).map(c => c.id)).toEqual(['o1', 's1']);
  });
  it('nenhuma conta gravada → carrinho intacto', () => {
    expect(carrinhoAposOrcamentoParcial(cart, []).map(c => c.id)).toEqual(['o1', 'c1', 's1']);
  });
});
