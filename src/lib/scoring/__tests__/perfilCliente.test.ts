import { describe, it, expect } from 'vitest';
import { classificarPerfilCliente } from '../perfilCliente';

// Oráculo do perfil comercial do cliente. O rótulo entra no prompt da IA que gera a
// abordagem (`generate-bundle-argument`, `generate-tactical-plan`), então um perfil
// fabricado vira a conversa que a vendedora leva para a rua.
//
// ESPELHO de supabase/functions/_shared/tactical-margem.ts:classifyProfile (já blindado
// pelo #1498). Este módulo unifica as DUAS cópias que existiam no front —
// useTacticalPlan.classifyProfile e useBundleArguments.classifyCustomerProfile.

describe('classificarPerfilCliente — margem desconhecida não decide', () => {
  it('gasto baixo + margem DESCONHECIDA não vira "sensivel_preco"', () => {
    // `null < 20` é true em JS (null coage a 0). Sem o guard, todo cliente de gasto baixo
    // sem custo apurado seria rotulado sensível a preço — e a vendedora entraria com
    // desconto na mão por causa de um dado que ninguém mediu.
    expect(classificarPerfilCliente(50, 400, null, 5)).toBe('misto');
    expect(classificarPerfilCliente(50, 400, undefined as unknown as null, 5)).toBe('misto');
  });

  it('margem DESCONHECIDA não vira "orientado_qualidade"', () => {
    // `null > 35` é false, então este ramo não dispara por coação — mas o guard explícito
    // impede que uma futura inversão do comparador o reintroduza em silêncio.
    expect(classificarPerfilCliente(50, 400, null, 2)).toBe('misto');
  });

  it('NaN e não-finito são desconhecidos, não margem zero', () => {
    expect(classificarPerfilCliente(50, 400, NaN, 5)).toBe('misto');
    expect(classificarPerfilCliente(50, 400, Infinity, 2)).toBe('misto');
  });
});

describe('classificarPerfilCliente — margem conhecida decide como antes', () => {
  it('gasto baixo + margem baixa CONHECIDA é sensivel_preco', () => {
    expect(classificarPerfilCliente(50, 400, 10, 5)).toBe('sensivel_preco');
  });

  it('margem 0 CONHECIDA é veredito e dispara sensivel_preco', () => {
    expect(classificarPerfilCliente(50, 400, 0, 5)).toBe('sensivel_preco');
  });

  it('margem alta + poucas categorias é orientado_qualidade', () => {
    expect(classificarPerfilCliente(50, 400, 40, 2)).toBe('orientado_qualidade');
  });

  it('margem no limite não dispara (fronteiras são estritas: <20 e >35)', () => {
    expect(classificarPerfilCliente(50, 400, 20, 5)).toBe('misto');
    expect(classificarPerfilCliente(50, 400, 35, 2)).toBe('misto');
  });

  it('gasto alto vence a fronteira de gasto baixo', () => {
    expect(classificarPerfilCliente(50, 600, 10, 5)).toBe('misto');
  });
});

describe('classificarPerfilCliente — ramo que não depende de margem', () => {
  it('orientado_produtividade dispara mesmo com margem desconhecida', () => {
    // Este ramo só olha gasto/categorias/health — não há razão para a ausência de margem
    // suprimir um perfil que não a usa.
    expect(classificarPerfilCliente(70, 3000, null, 5)).toBe('orientado_produtividade');
  });

  it('sem nenhuma regra satisfeita cai em misto', () => {
    expect(classificarPerfilCliente(50, 1000, 25, 5)).toBe('misto');
  });
});

describe('classificarPerfilCliente — precedência das regras', () => {
  it('sensivel_preco vence orientado_produtividade quando ambos casariam', () => {
    // avgSpend 400 (<500, margem 10 <20) e o terceiro ramo exige >2000: não colidem de fato,
    // mas a ordem é contratual — o primeiro ramo que casa vence.
    expect(classificarPerfilCliente(70, 400, 10, 5)).toBe('sensivel_preco');
  });

  it('orientado_qualidade vence orientado_produtividade quando ambos casariam', () => {
    // margem 40 (>35) e cat 3 (<=3) casam o 2º; o 3º exige cat>=4, então o 2º vence por ordem.
    expect(classificarPerfilCliente(70, 3000, 40, 3)).toBe('orientado_qualidade');
  });
});
