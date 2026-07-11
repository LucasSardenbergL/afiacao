import { describe, it, expect } from 'vitest';
import { extrairCodigoVendedor } from './codigo-vendedor';

// P0-B-bis (incidente carteira) — extração do vendedor do cadastro Omie (ListarClientes). O vendedor mora
// em recomendacoes.codigo_vendedor (o codigo_vendedor RAIZ vem vazio). Regra (Codex R2): recomendacoes é
// AUTORITATIVA — se presente (mesmo 0), decide; só cai no raiz se AUSENTE. Só inteiro POSITIVO safe conta.
describe('extrairCodigoVendedor (money-path: vendedor do cliente → carteira)', () => {
  it('recomendacoes tem código positivo → usa (fonte autoritativa)', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: 7 } })).toBe(7);
    expect(extrairCodigoVendedor({ recomendacoes: { codigo_vendedor: 7 } })).toBe(7);
  });

  it('recomendacoes AUSENTE (undefined/null), raiz positivo → cai no raiz (fallback)', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 41 })).toBe(41);
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: {} })).toBe(41);
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: null } })).toBe(41);
  });

  it('recomendacoes PRESENTE mas 0 → null, NÃO cai no raiz (0 = "sem vendedor" autoritativo — Codex P2)', () => {
    // `??`/`||` ingênuos cairiam no raiz (41). A regra: recomendacoes presente decide → 0 vira sem-vendedor.
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: 0 } })).toBeNull();
  });

  it('ambos ausentes/null → null', () => {
    expect(extrairCodigoVendedor({})).toBeNull();
    expect(extrairCodigoVendedor({ codigo_vendedor: null })).toBeNull();
  });

  it('raiz 0/negativo (recomendacoes ausente) → null', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 0 })).toBeNull();
    expect(extrairCodigoVendedor({ codigo_vendedor: -5 })).toBeNull();
  });

  it('não-inteiro (float) não conta como vendedor', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 1.5 })).toBeNull();
    expect(extrairCodigoVendedor({ recomendacoes: { codigo_vendedor: 1.5 } })).toBeNull();
  });

  it('código acima de 2^53 (não SafeInteger) → null (Codex P3: perderia precisão)', () => {
    expect(extrairCodigoVendedor({ recomendacoes: { codigo_vendedor: Number.MAX_SAFE_INTEGER + 1 } })).toBeNull();
    expect(extrairCodigoVendedor({ codigo_vendedor: Number.MAX_SAFE_INTEGER + 2 })).toBeNull();
  });

  it('FALSIFICAÇÃO: um extrator `recomendacoes ?? raiz` daria 0 no caso recomendacoes=0 (o guard tem dente)', () => {
    const r = extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: 0 } });
    expect(r).not.toBe(0);
    expect(r).not.toBe(41); // não ressuscita o raiz — recomendacoes=0 é autoritativo
    expect(r).toBeNull();
  });
});
