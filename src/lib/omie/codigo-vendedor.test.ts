import { describe, it, expect } from 'vitest';
import { extrairCodigoVendedor } from './codigo-vendedor';

// P0-B-bis (incidente carteira) — extração do vendedor do cadastro Omie (ListarClientes). O vendedor mora
// em recomendacoes.codigo_vendedor (o codigo_vendedor RAIZ vem vazio); padrão de omie-cliente/omie-sync.
// Regra centralizada p/ resolver a inconsistência ??/|| apontada pelo Codex: recomendacoes VENCE, e só
// inteiro POSITIVO conta (0/negativo/não-inteiro = não-atribuído). Alimenta a carteira → comissão.
describe('extrairCodigoVendedor (money-path: vendedor do cliente → carteira)', () => {
  it('recomendacoes tem código positivo → vence o raiz (fonte primária)', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: 7 } })).toBe(7);
    expect(extrairCodigoVendedor({ codigo_vendedor: 99, recomendacoes: { codigo_vendedor: 7 } })).toBe(7);
  });

  it('recomendacoes ausente/vazia, raiz positivo → usa o raiz (fallback)', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 41 })).toBe(41);
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: {} })).toBe(41);
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: null } })).toBe(41);
  });

  it('ambos ausentes/null → null (sem vendedor)', () => {
    expect(extrairCodigoVendedor({})).toBeNull();
    expect(extrairCodigoVendedor({ codigo_vendedor: null })).toBeNull();
    expect(extrairCodigoVendedor({ codigo_vendedor: null, recomendacoes: { codigo_vendedor: null } })).toBeNull();
  });

  it('0 NÃO é vendedor (Omie usa 0/vazio p/ não-atribuído): recomendacoes=0, raiz=41 → 41', () => {
    // O caso exato do Codex P2: `??` guardaria 0 (errado), `||` guardaria 41. A regra: 0 não conta → raiz.
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: 0 } })).toBe(41);
  });

  it('0/negativo em ambos → null', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 0 })).toBeNull();
    expect(extrairCodigoVendedor({ codigo_vendedor: -5, recomendacoes: { codigo_vendedor: 0 } })).toBeNull();
  });

  it('raiz×nested concordam (mesmo código) → esse código', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 7, recomendacoes: { codigo_vendedor: 7 } })).toBe(7);
  });

  it('não-inteiro (float) não conta como vendedor', () => {
    expect(extrairCodigoVendedor({ codigo_vendedor: 1.5 })).toBeNull();
    expect(extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: 1.5 } })).toBe(41);
  });

  it('FALSIFICAÇÃO: um extrator `recomendacoes ?? raiz` daria 0 no caso recomendacoes=0 (o guard tem dente)', () => {
    const r = extrairCodigoVendedor({ codigo_vendedor: 41, recomendacoes: { codigo_vendedor: 0 } });
    expect(r).not.toBe(0);
    expect(r).toBe(41);
  });
});
