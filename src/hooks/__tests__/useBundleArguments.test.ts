import { describe, it, expect } from 'vitest';
import { classifyCustomerProfile } from '@/hooks/useBundleArguments';

/**
 * O rótulo de perfil entra no argumento de venda que a vendedora leva para a rua.
 * Com `gross_margin_pct` passando a ser nullable (margem desconhecida = cliente sem custo
 * cadastrado), a coerção `null < 20 === true` rotularia toda essa população como
 * 'sensivel_preco' — um veredito comercial fabricado a partir de ausência de dado.
 */
describe('classifyCustomerProfile — margem ausente não fabrica rótulo', () => {
  it('margem null NÃO vira sensivel_preco, mesmo com gasto baixo', () => {
    // Sem o guard `!= null`: `null < 20` é true e este caso retornaria 'sensivel_preco'.
    expect(classifyCustomerProfile(50, 300, null, 2)).toBe('misto');
  });

  it('margem null NÃO vira orientado_qualidade (o outro ramo que lê margem)', () => {
    expect(classifyCustomerProfile(50, 300, null, 1)).toBe('misto');
  });

  it('margem null ainda permite os rótulos que NÃO dependem de margem', () => {
    expect(classifyCustomerProfile(70, 3000, null, 5)).toBe('orientado_produtividade');
  });

  it('margem CONHECIDA e baixa continua rotulando (o guard não anestesiou a regra)', () => {
    expect(classifyCustomerProfile(50, 300, 10, 2)).toBe('sensivel_preco');
  });

  it('margem conhecida ZERO é veredito real e rotula — distinto de ausência', () => {
    expect(classifyCustomerProfile(50, 300, 0, 2)).toBe('sensivel_preco');
  });

  it('margem alta com poucas categorias rotula orientado_qualidade', () => {
    expect(classifyCustomerProfile(50, 300, 40, 2)).toBe('orientado_qualidade');
  });
});
