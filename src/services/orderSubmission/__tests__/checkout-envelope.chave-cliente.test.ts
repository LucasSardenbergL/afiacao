import { describe, it, expect } from 'vitest';
import {
  chavesClienteCheckout, computeCheckoutFingerprint, decidirEnvelopeDoCliente, type CheckoutEnvelope,
} from '../checkout-envelope';

/**
 * Money-path (idempotência do PV) — defeito 2 do parecer Codex r5 do #4236: o MESMO cliente
 * confirmado não pode produzir outro fingerprint entre seleções (a saída do `conflict` é limpar
 * o cliente → 2º PV). E a chave estável não pode fazer um cliente reusar o envio de OUTRO.
 */
const U = '6f1c2d3e-0000-4000-8000-000000000173';
const W = '6f1c2d3e-0000-4000-8000-000000000999';
const itens = [{ account: 'oben', omie_codigo_produto: 9, quantity: 2, unit_price: 30.5 }];
/** A chave da main ANTES deste PR — para fabricar envelopes no formato antigo. */
const chaveLegada = (local: string | null | undefined, codigo: number) => String(local || codigo || '');
const env = (fingerprint: string, customerUserId: string | null, committed = true): CheckoutEnvelope =>
  ({ checkoutId: 'chk-1', fingerprint, committed, customerUserId, origem: null, atendimentoId: null });

describe('chave do cliente no fingerprint', () => {
  it('caso r5 (formato antigo): envelope nasceu com 173, nova seleção traz o vínculo U → reuse', () => {
    // 1ª seleção: mapa em lote sem vínculo; o id U veio por documento (customerUserId).
    const gravado = env(computeCheckoutFingerprint(chaveLegada(undefined, 173), itens), U);
    // Nova seleção: o mapa em lote preenche local_user_id = U.
    const r = decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 173 }, itens);
    expect(r.decision).toBe('reuse');
  });

  it('formato novo: a chave é a MESMA nas duas seleções (sem e com o vínculo do mapa)', () => {
    const a = decidirEnvelopeDoCliente(null, { customerUserId: U, localUserId: undefined, codigoCliente: 173 }, itens);
    expect(a.decision).toBe('new');
    const gravado = env(a.fingerprint, U);
    const b = decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 173 }, itens);
    expect(b.decision).toBe('reuse');
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('legado SEM titular congelado: casa só pelo alias do código Oben (ALIAS-LEGADO)', () => {
    const gravado = env(computeCheckoutFingerprint(chaveLegada(undefined, 173), itens), null);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 173 }, itens).decision).toBe('reuse');
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 174 }, itens).decision).toBe('conflict');
  });

  it('formato antigo pelo UUID do vínculo também casa (chave canônica)', () => {
    const gravado = env(computeCheckoutFingerprint(chaveLegada(U, 173), itens), U);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: undefined, codigoCliente: 173 }, itens).decision).toBe('reuse');
  });

  it('sem colisão: OUTRO cliente com os mesmos itens → conflict', () => {
    const gravado = env(computeCheckoutFingerprint(U, itens), U);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: W, localUserId: W, codigoCliente: 200 }, itens).decision).toBe('conflict');
  });

  it('alias pelo código NÃO reusa se o envelope congelou OUTRO usuário', () => {
    const gravado = env(computeCheckoutFingerprint(chaveLegada(undefined, 173), itens), W);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 173 }, itens).decision).toBe('conflict');
  });

  it('vínculo da busca DIVERGENTE do confirmado não vira alias', () => {
    const gravado = env(computeCheckoutFingerprint(W, itens), null);
    expect(chavesClienteCheckout({ customerUserId: U, localUserId: W, codigoCliente: 173 }).aliases).toEqual(['173']);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: W, codigoCliente: 173 }, itens).decision).toBe('conflict');
  });

  it('mesmo cliente, carrinho diferente → conflict (o alias não afrouxa os itens)', () => {
    const gravado = env(computeCheckoutFingerprint(chaveLegada(undefined, 173), itens), U);
    const outros = [{ ...itens[0], quantity: 3 }];
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 173 }, outros).decision).toBe('conflict');
  });

  it('código 0 nunca é chave nem alias', () => {
    expect(chavesClienteCheckout({ customerUserId: null, localUserId: null, codigoCliente: 0 })).toEqual({ canonica: '', aliases: [] });
    expect(chavesClienteCheckout({ customerUserId: U, localUserId: null, codigoCliente: 0 })).toEqual({ canonica: U, aliases: [] });
  });

  it('sem usuário confirmado (legado/autoatendimento): mantém a regra antiga', () => {
    expect(chavesClienteCheckout({ customerUserId: null, localUserId: U, codigoCliente: 173 }).canonica).toBe(U);
    expect(chavesClienteCheckout({ customerUserId: null, localUserId: null, codigoCliente: 173 }).canonica).toBe('173');
  });

  it('formato antigo 173 com o MESMO titular congelado e a seleção sem código Oben (360) → reuse', () => {
    const gravado = env(computeCheckoutFingerprint(chaveLegada(undefined, 173), itens), U);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 0 }, itens).decision).toBe('reuse');
  });

  it('fp igual à canônica mas titular congelado DIVERGENTE → conflict (nunca reusa outro titular)', () => {
    const gravado = env(computeCheckoutFingerprint(chaveLegada(U, 173), itens), W);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 173 }, itens).decision).toBe('conflict');
  });

  it('não committed com fp diferente segue "new" (nada pendente a proteger)', () => {
    const gravado = env(computeCheckoutFingerprint(W, itens), W, false);
    expect(decidirEnvelopeDoCliente(gravado, { customerUserId: U, localUserId: U, codigoCliente: 173 }, itens).decision).toBe('new');
  });
});
