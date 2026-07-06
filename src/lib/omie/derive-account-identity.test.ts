import { describe, it, expect } from 'vitest';
import { decideAccountIdentity } from './derive-account-identity';

const A = 'oben';

describe('decideAccountIdentity (threat-model P0-B §5)', () => {
  it('espelho com 1 código na conta → usa (source mirror, sem backfill)', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: 100,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }],
      omieMatches: null,
    });
    expect(r).toEqual({ ok: true, source: 'mirror', codigo_cliente: 100, codigo_vendedor: 9, backfill: false });
  });

  it('espelho vazio, sem Omie ainda → pede Omie', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: null });
    expect(r).toEqual({ ok: false, needOmie: true });
  });

  it('espelho vazio, Omie 1 match → usa + backfill', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }],
    });
    expect(r).toEqual({ ok: true, source: 'omie', codigo_cliente: 200, codigo_vendedor: 7, backfill: true });
  });

  it('Omie >1 match (duplicata-CNPJ) → fail-closed ambiguous_omie', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }, { codigo_cliente: 201, codigo_vendedor: 7 }],
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_omie' });
  });

  it('Omie 0 match (ausência confirmada) → fail-closed absent', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: [] });
    expect(r).toEqual({ ok: false, reason: 'absent' });
  });

  it('espelho >1 código distinto na conta → fail-closed ambiguous_mirror', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, omieMatches: null,
      mirrorRows: [
        { omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A },
        { omie_codigo_cliente: 101, omie_codigo_vendedor: 9, empresa_omie: A },
      ],
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_mirror' });
  });

  it('espelho só tem linha de OUTRA conta → ignora, pede Omie', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, omieMatches: null,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: 'colacor' }],
    });
    expect(r).toEqual({ ok: false, needOmie: true });
  });

  it('divergência supplied != derived → fail-closed', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: 999,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }],
      omieMatches: null,
    });
    expect(r).toEqual({ ok: false, reason: 'divergence' });
  });

  it('supplied == derived (mesmo número, tipos diferentes) → ok (bigint-safe por string)', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: 100,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }],
      omieMatches: null,
    });
    expect(r).toEqual({ ok: true, source: 'mirror', codigo_cliente: 100, codigo_vendedor: 9, backfill: false });
  });

  it('código não SafeInteger → fail-closed unsafe_integer', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: Number.MAX_SAFE_INTEGER + 1, codigo_vendedor: 1 }],
    });
    expect(r).toEqual({ ok: false, reason: 'unsafe_integer' });
  });
});
