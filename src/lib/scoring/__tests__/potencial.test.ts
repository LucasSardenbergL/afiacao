import { describe, it, expect } from 'vitest';
import { potencialConhecido } from '../potencial';

describe('potencialConhecido', () => {
  it('null e undefined são AUSÊNCIA → null', () => {
    expect(potencialConhecido(null)).toBeNull();
    expect(potencialConhecido(undefined)).toBeNull();
  });

  it('0 é CONHECIDO (veredito medido "sem potencial"), não ausência', () => {
    expect(potencialConhecido(0)).toBe(0);
  });

  it('número positivo passa', () => {
    expect(potencialConhecido(42.5)).toBe(42.5);
  });

  it('string numérica do PostgREST (numeric vira string) é aceita', () => {
    expect(potencialConhecido('1000')).toBe(1000);
  });

  it('não-finito degrada para null, jamais para 0', () => {
    expect(potencialConhecido(NaN)).toBeNull();
    expect(potencialConhecido(Infinity)).toBeNull();
    expect(potencialConhecido(-Infinity)).toBeNull();
  });

  it('lixo que Number() coagiria a 0 NÃO vira o veredito "medi e deu zero"', () => {
    // Number('') === 0, Number('  ') === 0, Number(false) === 0, Number([]) === 0.
    // Aceitar isso fabricaria a medição que este helper existe para impedir.
    expect(potencialConhecido('')).toBeNull();
    expect(potencialConhecido('   ')).toBeNull();
    expect(potencialConhecido(false)).toBeNull();
    expect(potencialConhecido([])).toBeNull();
    expect(potencialConhecido({})).toBeNull();
  });

  it('o retorno é null-ável no TIPO — o guard é obrigação do chamador', () => {
    // Regressão de contrato: se alguém "simplificar" o helper para devolver 0 em vez de null,
    // este teste quebra. É o null que força o guard explícito nos chamadores; um 0 aqui
    // reintroduziria a fabricação silenciosamente em todos eles de uma vez.
    const ausente: number | null = potencialConhecido(null);
    expect(ausente).toBeNull();
    expect(ausente).not.toBe(0);
  });
});
