import { describe, it, expect } from 'vitest';
import { churnConhecido } from '../churn';

/**
 * `churn_risk` está 100% preenchido em prod hoje (6.633/6.633), então estes testes fixam
 * comportamento que ainda não é exercido por dado real — são a prova de que a DEFESA funciona no
 * dia em que o produtor mudar, não a prova de um bug corrente. A distinção está no helper.
 */
describe('churnConhecido', () => {
  it('preserva 0 como veredito conhecido, não como ausência', () => {
    // O ponto central: 0 é "cliente sem risco", o MELHOR resultado. Tratá-lo como ausente foi
    // exatamente o que `churn_risk || 100` fazia — invertia o melhor cliente no pior.
    expect(churnConhecido(0)).toBe(0);
  });

  it('devolve o número quando conhecido', () => {
    expect(churnConhecido(96)).toBe(96);
    expect(churnConhecido('33')).toBe(33);
  });

  it('devolve null para ausente ou não-finito', () => {
    expect(churnConhecido(null)).toBeNull();
    expect(churnConhecido(undefined)).toBeNull();
    expect(churnConhecido(NaN)).toBeNull();
    expect(churnConhecido(Infinity)).toBeNull();
  });
});

describe('o guard relacional que o helper existe para permitir', () => {
  it('fixa o hazard: `null < 30` é TRUE em JS (null coage a 0)', () => {
    // Não é curiosidade — é a razão de o helper devolver null em vez de um número. Um consumidor
    // que faça `if (churn < 30)` direto sobre a coluna classifica o NÃO-MEDIDO como risco baixo.
    expect((null as unknown as number) < 30).toBe(true);
  });

  it('com o helper, ausente não passa por risco baixo — a checagem fica explícita', () => {
    const desconhecido = churnConhecido(null);
    expect(desconhecido != null && desconhecido < 30).toBe(false);

    const conhecidoBaixo = churnConhecido(10);
    expect(conhecidoBaixo != null && conhecidoBaixo < 30).toBe(true);

    // E 0 — o melhor cliente — continua contando como risco baixo, não como ausência.
    const semRisco = churnConhecido(0);
    expect(semRisco != null && semRisco < 30).toBe(true);
  });
});
